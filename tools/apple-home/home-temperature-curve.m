// Copyright © 2026 Michael Shields
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// The Home app's temperature-to-color curve. Evaluates
// -[HFTemperatureColor hf_RGBColorRepresentation], which the Home app uses to
// draw a color temperature and to turn one into Hue and Saturation, for each
// whole mired from 50 to 600 and prints one TSV row per mired. Before the
// rows it compares Apple's output with the closed form below, over 50 to 600
// mired in steps of 0.25 and over 500 to 20000 K in steps of 50, and prints
// the largest differences as "# check" lines.
//
// The closed form was read from the disassembly of the helper that
// hf_RGBColorRepresentation calls on macOS 27.2.1: it is the function
// _HFGetColorForLightTemperature(kelvin, &r, &g, &b), which writes three
// doubles. Each channel is clamp01(a + b / (K + c)) with the constants below,
// split at 6500 K for red and green, and black outside 1000 to 40000 K. They
// are 64-bit doubles read from the framework's constant data, so
// they are specific to this build. src/convert.ts holds the same curve as
// colorTempToHueSaturation.

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <math.h>
#import <objc/message.h>
#import <objc/runtime.h>

static double clamp01(double x) { return fmin(1.0, fmax(0.0, x)); }

static void closedForm(double k, double rgb[3]) {
  if (k < 1000 || k > 40000) {
    rgb[0] = rgb[1] = rgb[2] = 0;
    return;
  }
  int warm = k <= 6500;
  rgb[0] = warm ? 1 : 0.55995389139931484 + 1745.0425298314171 / (k - 2666.3474220535695);
  rgb[1] = warm ? 1.3302673723350029 + -2902.1955373783176 / (k + 1669.5803561666639)
                : 0.70381203140554549 + 1216.6168361476491 / (k - 2173.101234308223);
  rgb[2] = 1.8993753891711276 + -8257.7997278925686 / (k + 2575.2827530017594);
  for (int i = 0; i < 3; i++) rgb[i] = clamp01(rgb[i]);
}

static void hueSaturation(const double rgb[3], double *hue, double *sat) {
  double mx = fmax(rgb[0], fmax(rgb[1], rgb[2])), mn = fmin(rgb[0], fmin(rgb[1], rgb[2])), d = mx - mn;
  *sat = mx > 0 ? d / mx * 100 : 0;
  double h = 0;
  if (d > 0) {
    if (mx == rgb[0]) h = fmod((rgb[1] - rgb[2]) / d + (rgb[1] < rgb[2] ? 6 : 0), 6);
    else if (mx == rgb[1]) h = (rgb[2] - rgb[0]) / d + 2;
    else h = (rgb[0] - rgb[1]) / d + 4;
  }
  *hue = h * 60;
}

static double planeDistance(double h1, double s1, double h2, double s2) {
  double a = h1 * M_PI / 180, b = h2 * M_PI / 180;
  return hypot(s1 * cos(a) - s2 * cos(b), s1 * sin(a) - s2 * sin(b));
}

static id send0(id o, const char *sel) { return ((id (*)(id, SEL))objc_msgSend)(o, sel_registerName(sel)); }

typedef struct {
  float r, g, b, h, s;
} Sample;

static Sample apple(Class tc, const char *initSel, float value) {
  id t = ((id (*)(id, SEL, float))objc_msgSend)([tc alloc], sel_registerName(initSel), value);
  id rgb = send0(t, "hf_RGBColorRepresentation");
  Sample x;
  float b;
  ((void (*)(id, SEL, float *, float *, float *))objc_msgSend)(rgb, sel_registerName("getHue:saturation:brightness:"), &x.h,
                                                               &x.s, &b);
  x.r = ((float (*)(id, SEL))objc_msgSend)(rgb, sel_registerName("red"));
  x.g = ((float (*)(id, SEL))objc_msgSend)(rgb, sel_registerName("green"));
  x.b = ((float (*)(id, SEL))objc_msgSend)(rgb, sel_registerName("blue"));
  return x;
}

static void compare(Sample a, double kelvin, double *maxRGB, double *maxPlane) {
  double rgb[3], hue, sat;
  closedForm(kelvin, rgb);
  hueSaturation(rgb, &hue, &sat);
  *maxRGB = fmax(*maxRGB, fmax(fabs(rgb[0] - a.r), fmax(fabs(rgb[1] - a.g), fabs(rgb[2] - a.b))));
  *maxPlane = fmax(*maxPlane, planeDistance(a.h * 360, a.s * 100, hue, sat));
}

int main(void) {
  @autoreleasepool {
    if (!dlopen("/System/iOSSupport/System/Library/PrivateFrameworks/Home.framework/Home", RTLD_NOW)) {
      printf("dlopen failed: %s\n", dlerror());
      return 1;
    }
    Class tc = NSClassFromString(@"HFTemperatureColor");
    double maxRGB = 0, maxPlane = 0, maxKRGB = 0, maxKPlane = 0;
    for (int i = 0; i <= 2200; i++) {
      float mired = 50 + 0.25f * i;
      compare(apple(tc, "initWithTemperatureInMired:", mired), 1e6 / mired, &maxRGB, &maxPlane);
    }
    for (int k = 500; k <= 20000; k += 50) {
      compare(apple(tc, "initWithTemperatureInKelvin:", k), k, &maxKRGB, &maxKPlane);
    }
    printf("# check mired 50..600 step 0.25: max RGB difference %.2e, max hue/saturation plane distance %.2e\n", maxRGB,
           maxPlane);
    printf("# check kelvin 500..20000 step 50: max RGB difference %.2e, max hue/saturation plane distance %.2e\n", maxKRGB,
           maxKPlane);
    printf("mired\tkelvin\tred\tgreen\tblue\thue\tsaturation\n");
    for (int m = 50; m <= 600; m++) {
      Sample x = apple(tc, "initWithTemperatureInMired:", m);
      printf("%d\t%.1f\t%.9g\t%.9g\t%.9g\t%.4f\t%.4f\n", m, 1e6 / m, x.r, x.g, x.b, x.h * 360.0, x.s * 100.0);
    }
  }
  return 0;
}
