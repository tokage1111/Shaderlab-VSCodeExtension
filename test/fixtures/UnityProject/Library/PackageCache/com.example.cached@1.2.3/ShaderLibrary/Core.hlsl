#ifndef CORE_INCLUDED
#define CORE_INCLUDED

#define real half
#define real3 half3
#define real4 half4
#define CBUFFER_START(name) cbuffer name {
#define CBUFFER_END };
#define TEXTURE2D(textureName) Texture2D textureName
#define SAMPLER(samplerName) SamplerState samplerName
#define TEXTURE2D_PARAM(textureName, samplerName) Texture2D textureName, SamplerState samplerName
#define TEXTURE2D_ARGS(textureName, samplerName) textureName, samplerName
#define SAMPLE_TEXTURE2D(textureName, samplerName, coord2) textureName.Sample(samplerName, coord2)
#define TRANSFORM_TEX(tex, name) ((tex.xy) * name##_ST.xy + name##_ST.zw)
#define UNITY_VERTEX_INPUT_INSTANCE_ID uint instanceID : SV_InstanceID;
#define UNITY_SETUP_INSTANCE_ID(input)

float4x4 unity_ObjectToWorld;
float4x4 unity_MatrixVP;

struct VertexPositionInputs
{
    float3 positionWS;
    float4 positionCS;
};

float4 TransformObjectToHClip(float3 positionOS)
{
    return mul(unity_MatrixVP, mul(unity_ObjectToWorld, float4(positionOS, 1.0)));
}

VertexPositionInputs GetVertexPositionInputs(float3 positionOS)
{
    VertexPositionInputs inputs;
    inputs.positionWS = mul(unity_ObjectToWorld, float4(positionOS, 1.0)).xyz;
    inputs.positionCS = TransformObjectToHClip(positionOS);
    return inputs;
}

half4 SampleAlbedo(float2 uv, TEXTURE2D_PARAM(albedoMap, sampler_albedoMap))
{
    return SAMPLE_TEXTURE2D(albedoMap, sampler_albedoMap, uv);
}

void GetLighting(float3 normal, out half3 color, inout float attenuation)
{
    color = normal;
    attenuation *= 0.5;
}

#endif
