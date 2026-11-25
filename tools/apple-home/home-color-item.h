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

// Shared by the home-color-*.m programs. Builds a subclass of Apple's
// HFColorControlItem whose characteristic options and metadata come from the
// globals below, so that its write and read-back logic runs without a home,
// accessory, or HomeKit connection.

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

#define HOME_FRAMEWORKS "/System/iOSSupport/System/Library/PrivateFrameworks/"

static NSString *const kHue = @"00000013-0000-1000-8000-0026BB765291";
static NSString *const kSaturation = @"0000002F-0000-1000-8000-0026BB765291";
static NSString *const kColorTemperature = @"000000CE-0000-1000-8000-0026BB765291";

static NSSet *gTypes;  // characteristic types the stub exposes
static NSNumber *gCTmin, *gCTmax, *gCTstep;
static NSNumber *gHueMax, *gHueStep, *gSatStep;

@interface StubOptions : NSObject
@end
@implementation StubOptions
- (NSSet *)characteristicTypesForUsage:(NSUInteger)u {
  return gTypes;
}
@end

@interface StubSource : NSObject
@end
@implementation StubSource
- (id)metadataForCharacteristicType:(NSString *)t {
  Class mc = NSClassFromString(@"HMCharacteristicMetadata");
  id m = [[mc alloc] init];
#define SET(sel, v) ((void (*)(id, SEL, id))objc_msgSend)(m, sel_registerName(sel), v)
  SET("setFormat:", @"float");
  if ([t isEqualToString:kHue]) {
    SET("setMinimumValue:", @0);
    SET("setMaximumValue:", gHueMax);
    SET("setStepValue:", gHueStep);
  } else if ([t isEqualToString:kSaturation]) {
    SET("setMinimumValue:", @0);
    SET("setMaximumValue:", @100);
    SET("setStepValue:", gSatStep);
  } else if ([t isEqualToString:kColorTemperature]) {
    if (!gCTmin) return nil;
    SET("setMinimumValue:", gCTmin);
    SET("setMaximumValue:", gCTmax);
    SET("setStepValue:", gCTstep);
  }
  return m;
}
@end

static id gOptions, gSource;
static id stub_options(id self, SEL _cmd) { return gOptions; }
static id stub_source(id self, SEL _cmd) { return gSource; }

static id item;

// Loads the frameworks and creates the stub item with the usual HAP ranges:
// Hue 0..360 and Saturation 0..100 in steps of 1, ColorTemperature 140..500
// in steps of 1. Pass YES to load HomeUI as well.
static void setupItem(BOOL withHomeUI) {
  dlopen(HOME_FRAMEWORKS "Home.framework/Home", RTLD_NOW);
  if (withHomeUI) dlopen(HOME_FRAMEWORKS "HomeUI.framework/HomeUI", RTLD_NOW);
  dlopen("/System/iOSSupport/System/Library/Frameworks/HomeKit.framework/HomeKit", RTLD_NOW);
  Class sub = objc_allocateClassPair(NSClassFromString(@"HFColorControlItem"), "StubColorItem", 0);
  class_addMethod(sub, sel_registerName("characteristicOptions"), (IMP)stub_options, "@@:");
  class_addMethod(sub, sel_registerName("valueSource"), (IMP)stub_source, "@@:");
  objc_registerClassPair(sub);
  item = [sub alloc];
  gOptions = [StubOptions new];
  gSource = [StubSource new];
  gHueMax = @360;
  gHueStep = @1;
  gSatStep = @1;
  gCTmin = @140;
  gCTmax = @500;
  gCTstep = @1;
}

static __attribute__((unused)) id rgb(float h, float s, float b) {
  return ((id (*)(id, SEL, float, float, float))objc_msgSend)(
      [NSClassFromString(@"HFRGBColor") alloc], sel_registerName("initWithHue:saturation:brightness:"), h / 360, s / 100, b);
}
static __attribute__((unused)) id temp(float mired) {
  return ((id (*)(id, SEL, float))objc_msgSend)([NSClassFromString(@"HFTemperatureColor") alloc],
                                                 sel_registerName("initWithTemperatureInMired:"), mired);
}
static __attribute__((unused)) id coll(NSArray *prims) {
  return ((id (*)(id, SEL, id))objc_msgSend)([NSClassFromString(@"HFColorCollection") alloc],
                                              sel_registerName("initWithPrimitiveColors:"), [NSSet setWithArray:prims]);
}

static NSString *shortName(NSString *k, BOOL abbreviated) {
  if ([k hasPrefix:@"00000013"]) return @"Hue";
  if ([k hasPrefix:@"0000002F"]) return abbreviated ? @"Sat" : @"Saturation";
  if ([k hasPrefix:@"000000CE"]) return abbreviated ? @"CT" : @"ColorTemperature";
  return k;
}

// What -[HFColorControlItem characteristicValuesForValue:] would write for a
// color collection, as "Hue=30, Saturation=66".
static __attribute__((unused)) NSString *writes(id collection, NSString *separator, BOOL abbreviated) {
  id r = ((id (*)(id, SEL, id))objc_msgSend)(item, sel_registerName("characteristicValuesForValue:"), collection);
  NSMutableArray *parts = [NSMutableArray array];
  for (NSString *k in [[(NSDictionary *)r allKeys] sortedArrayUsingSelector:@selector(compare:)]) {
    [parts addObject:[NSString stringWithFormat:@"%@=%@", shortName(k, abbreviated), ((NSDictionary *)r)[k]]];
  }
  return [parts componentsJoinedByString:separator];
}

// An object's description without its memory addresses, which differ on every
// run.
static __attribute__((unused)) NSString *describe(id o) {
  NSRegularExpression *address = [NSRegularExpression regularExpressionWithPattern:@"0x[0-9a-f]+" options:0 error:nil];
  NSString *d = [o description];
  return [address stringByReplacingMatchesInString:d options:0 range:NSMakeRange(0, d.length) withTemplate:@"0x"];
}
