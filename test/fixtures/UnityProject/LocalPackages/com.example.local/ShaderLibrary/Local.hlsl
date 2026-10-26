#ifndef LOCAL_INCLUDED
#define LOCAL_INCLUDED

#define LOCAL_SCALE 2.0
#define MULTI_LINE_MACRO(a, b) \
    ((a) + \
     (b))

float LocalFunction(float x) { return x * LOCAL_SCALE; }

#endif
