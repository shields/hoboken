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

// What the Home app's color wheels produce. Takes colors from HomeUI's
// temperature wheel and RGB wheel at known coordinates and prints what
// Apple's HFColorControlItem writes for them on a light with Hue and
// Saturation only and one with ColorTemperature as well. Also prints the
// temperature wheel's default and largest ranges.

#import "home-color-item.h"

typedef struct {
  double a, b;
} Coord;
typedef struct {
  double r, g, b, k;
} WheelColor;
typedef struct {
  double lo, hi;
} Range;

static id wheelcoll(WheelColor w) {
  NSMutableArray *p = [NSMutableArray array];
  [p addObject:((id (*)(id, SEL, float, float, float))objc_msgSend)([NSClassFromString(@"HFRGBColor") alloc],
                                                                    sel_registerName("initWithRed:green:blue:"),
                                                                    (float)w.r, (float)w.g, (float)w.b)];
  if (w.k < 1e300) {
    [p addObject:((id (*)(id, SEL, float))objc_msgSend)([NSClassFromString(@"HFTemperatureColor") alloc],
                                                         sel_registerName("initWithTemperatureInKelvin:"), (float)w.k)];
  }
  return coll(p);
}

static NSString *wr(id collection) { return writes(collection, @" ", YES); }

int main(void) {
  @autoreleasepool {
    setupItem(YES);
    Class tw = NSClassFromString(@"HUTemperatureColorWheelSpace");
    const char *rangeSels[] = {"defaultTemperatureRange", "largestAllowableTemperatureRange"};
    for (int i = 0; i < 2; i++) {
      Range r = ((Range (*)(id, SEL))objc_msgSend)(tw, sel_registerName(rangeSels[i]));
      printf("%s = %g, %g K\n", rangeSels[i], r.lo, r.hi);
    }
    NSSet *HS = [NSSet setWithObjects:kHue, kSaturation, nil];
    NSSet *HSC = [NSSet setWithObjects:kHue, kSaturation, kColorTemperature, nil];
    Range ranges[2] = {{2400, 10000}, {1e6 / 500, 1e6 / 140}};
    for (int ri = 0; ri < 2; ri++) {
      id space = ((id (*)(id, SEL, Range))objc_msgSend)([tw alloc], sel_registerName("initWithSupportedRange:"), ranges[ri]);
      printf("Temperature wheel, supportedRange %.1f..%.1f K%s\n", ranges[ri].lo, ranges[ri].hi,
             ri ? " (light with CT 140..500 mired)" : " (default)");
      for (double a = 0; a <= 1.0001; a += 0.05) {
        WheelColor w = ((WheelColor (*)(id, SEL, Coord))objc_msgSend)(space, sel_registerName("colorForCoordinate:"),
                                                                      (Coord){MIN(a, 1.0), 1.0});
        gTypes = HS;
        NSString *x = wr(wheelcoll(w));
        gTypes = HSC;
        NSString *y = wr(wheelcoll(w));
        printf("  angle %.2f -> %7.1f K %6.1f mired | HS-only: %-14s | HS+CT: %s\n", a, w.k, 1e6 / w.k, [x UTF8String],
               [y UTF8String]);
      }
    }
    id space = [[NSClassFromString(@"HUWheelColorWheelSpace") alloc] init];
    printf("RGB wheel (angle, radius)\n");
    double pts[][2] = {{0.6333, 0.787}, {0.6333, 0.0}, {0.6333, 0.08}, {0.6333, 0.5}, {0.6333, 1.0},
                       {0, 1},          {1.0 / 3, 1},  {0.0833, 0.5},  {0.0833, 0.3}};
    for (int i = 0; i < 9; i++) {
      WheelColor w = ((WheelColor (*)(id, SEL, Coord))objc_msgSend)(space, sel_registerName("colorForCoordinate:"),
                                                                    (Coord){pts[i][0], pts[i][1]});
      gTypes = HS;
      NSString *x = wr(wheelcoll(w));
      gTypes = HSC;
      NSString *y = wr(wheelcoll(w));
      printf("  angle %.4f r %.3f -> rgb %.3f %.3f %.3f k=%s | HS-only: %-16s | HS+CT: %s\n", pts[i][0], pts[i][1], w.r, w.g,
             w.b, w.k < 1e300 ? "set" : "none", [x UTF8String], [y UTF8String]);
    }
  }
}
