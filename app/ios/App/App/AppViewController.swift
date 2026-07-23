import UIKit
import Capacitor

/* Registreert onze eigen (in-app) Capacitor-plugins — vereist sinds Capacitor 6.
   Main.storyboard verwijst naar deze controller. */
class AppViewController: CAPBridgeViewController {
    override open func viewDidLoad() {
        super.viewDidLoad()
        webView?.scrollView.scrollsToTop = false   // tik op statusbalk scrolt de app niet meer omlaag/omhoog
        webView?.scrollView.bounces = false        // geen rubberband van de hele pagina
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NmeaPlugin())
    }
}
