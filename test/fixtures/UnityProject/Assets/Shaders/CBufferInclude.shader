Shader "Test/CBufferInclude"
{
    Properties
    {
        _TintColor ("Tint", Color) = (1, 1, 1, 1)
        _Strength ("Strength", Float) = 1
    }

    SubShader
    {
        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            #include "Packages/com.example.cached/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
            float4 _BeforeInclude;
            #include "Lib/MaterialProps.hlsl"
            float _AfterInclude;
            CBUFFER_END

            float4 vert(float4 positionOS : POSITION) : SV_POSITION
            {
                return positionOS * _Strength;
            }

            half4 frag() : SV_Target
            {
                return _TintColor * _Strength * _BeforeInclude * _AfterInclude;
            }
            ENDHLSL
        }
    }
}
