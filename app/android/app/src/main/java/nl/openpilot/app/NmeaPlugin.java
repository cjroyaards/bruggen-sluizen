package nl.openpilot.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** OpenPilot NMEA: rauwe TCP/UDP-ontvangst die de browser niet kan. */
@CapacitorPlugin(name = "Nmea")
public class NmeaPlugin extends Plugin {
    private Thread th; private java.net.Socket sock; private java.net.DatagramSocket ds;

    @PluginMethod
    public void connect(PluginCall call) {
        stop();
        String mode = call.getString("mode", "tcp");
        Integer port = call.getInt("port", 10110);
        final int p = port == null ? 10110 : port;
        if ("udp".equals(mode)) {
            th = new Thread(() -> { try {
                ds = new java.net.DatagramSocket(p); byte[] b = new byte[4096];
                while (!Thread.interrupted()) {
                    java.net.DatagramPacket pk = new java.net.DatagramPacket(b, b.length);
                    ds.receive(pk);
                    for (String l : new String(pk.getData(), 0, pk.getLength()).split("\r?\n")) emit(l);
                }
            } catch (Exception e) { state("error", e.getMessage()); } });
            th.start(); call.resolve(); return;
        }
        final String host = call.getString("host", "");
        th = new Thread(() -> { try {
            sock = new java.net.Socket(host, p); state("open", null);
            java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(sock.getInputStream()));
            String l; while ((l = r.readLine()) != null) emit(l);
            state("closed", null);
        } catch (Exception e) { state("error", e.getMessage()); } });
        th.start(); call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) { stop(); call.resolve(); }

    private void emit(String l) { JSObject o = new JSObject(); o.put("l", l.trim()); notifyListeners("line", o); }
    private void state(String s, String m) { JSObject o = new JSObject(); o.put("state", s); if (m != null) o.put("msg", m); notifyListeners("state", o); }
    private void stop() {
        try { if (sock != null) sock.close(); } catch (Exception e) {}
        try { if (ds != null) ds.close(); } catch (Exception e) {}
        if (th != null) th.interrupt();
        sock = null; ds = null; th = null;
    }
}
