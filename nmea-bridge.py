#!/usr/bin/env python3
# OpenPilot NMEA-brug: leest NMEA 0183 van een TCP- of UDP-gateway en serveert het als WebSocket.
# Alleen standaard-Python (3.8+), niets installeren. Voorbeelden:
#   python3 nmea-bridge.py --tcp 192.168.0.80:1456
#   python3 nmea-bridge.py --udp 2000
# Verbind daarna in OpenPilot (plotter → NMEA) met:  ws://<ip-van-deze-computer>:8100
# Draait de brug op dezelfde computer als de browser? Dan werkt  ws://localhost:8100  ook vanaf https.
import argparse, base64, hashlib, socket, struct, sys, threading, time

clients = []                 # verbonden websocket-sockets
lock = threading.Lock()
MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def ws_accept(key):
    return base64.b64encode(hashlib.sha1((key + MAGIC).encode()).digest()).decode()

def ws_frame(text):
    data = text.encode()
    n = len(data)
    if n < 126:   head = struct.pack("!BB", 0x81, n)
    elif n < 65536: head = struct.pack("!BBH", 0x81, 126, n)
    else:         head = struct.pack("!BBQ", 0x81, 127, n)
    return head + data

def broadcast(line):
    frame = ws_frame(line)
    with lock:
        dead = []
        for c in clients:
            try: c.sendall(frame)
            except OSError: dead.append(c)
        for c in dead:
            clients.remove(c)
            try: c.close()
            except OSError: pass

def ws_server(port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port)); srv.listen(5)
    print(f"[brug] WebSocket-server op poort {port} — verbind met ws://<dit-ip>:{port}")
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=ws_client, args=(conn, addr), daemon=True).start()

def ws_client(conn, addr):
    try:
        req = conn.recv(4096).decode(errors="ignore")
        key = None
        for ln in req.split("\r\n"):
            if ln.lower().startswith("sec-websocket-key:"):
                key = ln.split(":", 1)[1].strip()
        if not key:
            conn.close(); return
        conn.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {ws_accept(key)}\r\n\r\n").encode())
        with lock: clients.append(conn)
        print(f"[brug] app verbonden: {addr[0]} (totaal {len(clients)})")
        # inkomende frames (bijv. SignalK-subscribe) lezen en negeren; close netjes afhandelen
        while True:
            hdr = conn.recv(2)
            if len(hdr) < 2: break
            op = hdr[0] & 0x0F
            ln = hdr[1] & 0x7F
            mask = hdr[1] & 0x80
            if ln == 126: ln = struct.unpack("!H", conn.recv(2))[0]
            elif ln == 127: ln = struct.unpack("!Q", conn.recv(8))[0]
            if mask: conn.recv(4)
            while ln > 0:
                chunk = conn.recv(min(ln, 4096))
                if not chunk: break
                ln -= len(chunk)
            if op == 0x8: break   # close
    except OSError:
        pass
    finally:
        with lock:
            if conn in clients: clients.remove(conn)
        try: conn.close()
        except OSError: pass
        print(f"[brug] app weg: {addr[0]} (totaal {len(clients)})")

def tcp_reader(host, port):
    while True:
        try:
            print(f"[brug] verbinden met gateway {host}:{port} (TCP)…")
            s = socket.create_connection((host, port), timeout=10)
            s.settimeout(30)
            print("[brug] gateway verbonden ✓")
            buf = b""
            while True:
                d = s.recv(4096)
                if not d: raise OSError("verbinding gesloten")
                buf += d
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    t = line.decode(errors="ignore").strip()
                    if t: broadcast(t + "\r\n")
        except OSError as e:
            print(f"[brug] gateway-fout: {e} — opnieuw over 3 s")
            time.sleep(3)

def udp_reader(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    print(f"[brug] luistert op UDP-poort {port}")
    while True:
        d, _ = s.recvfrom(4096)
        for line in d.decode(errors="ignore").splitlines():
            t = line.strip()
            if t: broadcast(t + "\r\n")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="OpenPilot NMEA-brug: TCP/UDP → WebSocket")
    ap.add_argument("--tcp", help="gateway host:poort, bijv. 192.168.0.80:1456")
    ap.add_argument("--udp", type=int, help="UDP-poort om op te luisteren, bijv. 2000")
    ap.add_argument("--listen", type=int, default=8100, help="WebSocket-poort (standaard 8100)")
    a = ap.parse_args()
    if not a.tcp and not a.udp:
        ap.error("geef --tcp host:poort of --udp poort op")
    threading.Thread(target=ws_server, args=(a.listen,), daemon=True).start()
    if a.tcp:
        host, _, port = a.tcp.partition(":")
        threading.Thread(target=tcp_reader, args=(host, int(port or 2000)), daemon=True).start()
    if a.udp:
        threading.Thread(target=udp_reader, args=(a.udp,), daemon=True).start()
    print("[brug] klaar — Ctrl-C om te stoppen")
    try:
        while True: time.sleep(3600)
    except KeyboardInterrupt:
        print("\n[brug] gestopt")
