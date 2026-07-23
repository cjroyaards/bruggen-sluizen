#import <Capacitor/Capacitor.h>
CAP_PLUGIN(NmeaPlugin, "Nmea",
  CAP_PLUGIN_METHOD(connect, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(disconnect, CAPPluginReturnPromise);
)
