Shader "Test/Lit"
{
    Properties
    {
        [MainTexture] _BaseMap ("Base Map", 2D) = "white" {}
        [MainColor] _BaseColor ("Base Color", Color) = (1, 1, 1, 1)
        _Cutoff ("Cutoff", Range(0, 1)) = 0.5
        [NoScaleOffset]
        _Undeclared ("Undeclared", Float) = 1
    }

    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }

        HLSLINCLUDE
        #include "Packages/com.example.cached/ShaderLibrary/Core.hlsl"
        #include "Lib/Input.hlsl"
        ENDHLSL

        Pass
        {
            Name "Forward"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Lib/Common.hlsl"
            #include "Packages/com.example.embedded/ShaderLibrary/Embedded.hlsl"
            #include "Packages/com.example.local/ShaderLibrary/Local.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS : NORMAL;
                float2 uv : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 normalWS : TEXCOORD1;
            };

            Varyings vert(Attributes input)
            {
                Varyings output;
                UNITY_SETUP_INSTANCE_ID(input);
                VertexPositionInputs positionInputs = GetVertexPositionInputs(input.positionOS.xyz);
                output.positionCS = positionInputs.positionCS;
                output.uv = TRANSFORM_TEX(input.uv, _BaseMap);
                output.normalWS = input.normalOS;
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                half4 albedo = SampleAlbedo(input.uv, TEXTURE2D_ARGS(_BaseMap, sampler_BaseMap));
                half3 lighting;
                float attenuation = 1.0;
                GetLighting(input.normalWS, lighting, attenuation);
                float scale = LocalFunction(EmbeddedFunction(1.0)) + MULTI_LINE_MACRO(1.0, 2.0);
                {
                    float scale = 2.0;
                    albedo.rgb *= scale;
                }
                clip(albedo.a - _Cutoff);
                return albedo * GetTint() * scale;
            }
            ENDHLSL
        }

        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }

            HLSLPROGRAM
            #pragma vertex ShadowVert
            #pragma fragment ShadowFrag

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float depth : TEXCOORD0;
            };

            Varyings ShadowVert(float4 positionOS : POSITION)
            {
                Varyings output;
                output.positionCS = TransformObjectToHClip(positionOS.xyz);
                output.depth = output.positionCS.z;
                return output;
            }

            half4 ShadowFrag(Varyings input) : SV_Target
            {
                return input.depth;
            }
            ENDHLSL
        }
    }
}
