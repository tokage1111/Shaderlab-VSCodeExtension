#ifndef COMMON_INCLUDED
#define COMMON_INCLUDED

// _BaseColor は Input.hlsl で宣言される(rootのinclude順に依存する)。
half4 GetTint()
{
    return _BaseColor;
}

#endif
