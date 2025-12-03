struct LayoutUniform {
    scale: vec2<f32>,
    translate: vec2<f32>,
    uv_scale: vec2<f32>,
    uv_offset: vec2<f32>,
    alpha: f32,
    // Rotation in radians, applied around the quad center in clip space.
    rotation: f32,
    // Padding to keep the struct size aligned to 12 floats (48 bytes).
    _padding: vec2<f32>,
}

@group(0) @binding(0)
var<uniform> layout_uniform: LayoutUniform;

@group(1) @binding(0)
var video_sampler: sampler;

@group(1) @binding(1)
var video_texture: texture_external;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) uv: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vsMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Start from a unit quad in clip space, scale to target rect, then rotate, then translate.
    var pos = input.position;
    pos *= layout_uniform.scale;

    let angle = layout_uniform.rotation;
    let s = sin(angle);
    let c = cos(angle);

    let rotated = vec2<f32>(
        pos.x * c - pos.y * s,
        pos.x * s + pos.y * c,
    );

    let final_pos = rotated + layout_uniform.translate;
    output.clip_position = vec4<f32>(final_pos, 0.0, 1.0);
    output.uv = input.uv * layout_uniform.uv_scale + layout_uniform.uv_offset;
    return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let sample = textureSampleBaseClampToEdge(video_texture, video_sampler, input.uv);
    let final_alpha = clamp(sample.a * layout_uniform.alpha, 0.0, 1.0);
    return vec4<f32>(sample.rgb, final_alpha);
}

