import Foundation
import Capacitor
import Network

/* OpenPilot NMEA: rauwe TCP/UDP-ontvangst die de browser niet kan.
   Eenmalig in Xcode: sleep NmeaPlugin.swift + NmeaPlugin.m in de map "App" (add to target App). */
@objc(NmeaPlugin)
public class NmeaPlugin: CAPPlugin {
    var conn: NWConnection?
    var listener: NWListener?
    var buf = Data()

    @objc func connect(_ call: CAPPluginCall) {
        disconnectAll()
        let mode = call.getString("mode") ?? "tcp"
        let port = NWEndpoint.Port(rawValue: UInt16(call.getInt("port") ?? 10110))!
        if mode == "udp" {
            do {
                let l = try NWListener(using: .udp, on: port)
                l.newConnectionHandler = { [weak self] c in c.start(queue: .global()); self?.receiveLoop(c) }
                l.start(queue: .global())
                listener = l
                call.resolve(["ok": true])
            } catch { call.reject("udp: \(error.localizedDescription)") }
            return
        }
        guard let host = call.getString("host"), !host.isEmpty else { call.reject("host ontbreekt"); return }
        let c = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tcp)
        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .ready: self?.notifyListeners("state", data: ["state": "open"])
            case .failed(let e): self?.notifyListeners("state", data: ["state": "error", "msg": e.localizedDescription])
            case .cancelled: self?.notifyListeners("state", data: ["state": "closed"])
            default: break
            }
        }
        c.start(queue: .global())
        conn = c
        receiveLoop(c)
        call.resolve(["ok": true])
    }

    func receiveLoop(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, err in
            guard let self = self else { return }
            if let d = data, !d.isEmpty {
                self.buf.append(d)
                while let nl = self.buf.firstIndex(of: 0x0A) {
                    let lineData = self.buf.prefix(upTo: nl)
                    self.buf.removeSubrange(...nl)
                    if let s = String(data: lineData, encoding: .utf8) {
                        self.notifyListeners("line", data: ["l": s.trimmingCharacters(in: .whitespacesAndNewlines)])
                    }
                }
            }
            if err != nil || done { self.notifyListeners("state", data: ["state": "closed"]); return }
            self.receiveLoop(c)
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) { disconnectAll(); call.resolve() }
    func disconnectAll() { conn?.cancel(); conn = nil; listener?.cancel(); listener = nil; buf.removeAll() }
}
