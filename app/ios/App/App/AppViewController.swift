import UIKit
import Capacitor

/* Registreert onze eigen (in-app) Capacitor-plugins — vereist sinds Capacitor 6.
   Main.storyboard verwijst naar deze controller. */
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NmeaPlugin())
    }
}
