Shader "Test/Errors"
{
    Properties
    {
        _Color ("Color", Color) = (1, 1, 1, 1)
    }
    SubShader
    {
        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment missingFragment
            #include "Packages/com.example.cached/ShaderLibrary/Core.hlsl"
            #include "DoesNotExist.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; };

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv = input.uv;
                return output;
            }
            ENDHLSL
        }
        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert2
            #pragma fragment frag2
            #include "Packages/com.example.cached/ShaderLibrary/Core.hlsl"

            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; };

            Varyings vert2(float4 positionOS : POSITION)
            {
                Varyings output;
                output.positionCS = TransformObjectToHClip(positionOS.xyz, 1.0);
                output.uv = positionOS.xyz;
                output.missingMember = 0;
                return output;
            }

            half4 frag2(Varyings input) : SV_Target
            {
                float3 mixed = input.positionCS.xyb;
                float value = undefinedVariable + _Color.r;
                float4 vector4 = lerp(input.positionCS, 1.0);
                return UndefinedFunction(input.uv) + input.uv.z;
            }
            ENDHLSL
        }
    }
}
