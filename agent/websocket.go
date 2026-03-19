package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	conn net.Conn
	r    *bufio.Reader
}

func wsConnect(rawURL string, extraHeaders http.Header) (*wsConn, error) {
	scheme, host, path, err := parseWsURL(rawURL)
	if err != nil {
		return nil, err
	}

	var conn net.Conn
	if scheme == "wss" {
		conn, err = tls.Dial("tcp", host, &tls.Config{InsecureSkipVerify: true})
	} else {
		conn, err = net.Dial("tcp", host)
	}
	if err != nil {
		return nil, fmt.Errorf("wsConnect: dial %s: %w", host, err)
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		conn.Close()
		return nil, fmt.Errorf("wsConnect: rand key: %w", err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	var sb strings.Builder
	sb.WriteString("GET " + path + " HTTP/1.1\r\n")
	sb.WriteString("Host: " + host + "\r\n")
	sb.WriteString("Upgrade: websocket\r\n")
	sb.WriteString("Connection: Upgrade\r\n")
	sb.WriteString("Sec-WebSocket-Key: " + key + "\r\n")
	sb.WriteString("Sec-WebSocket-Version: 13\r\n")
	for k, vals := range extraHeaders {
		for _, v := range vals {
			sb.WriteString(k + ": " + v + "\r\n")
		}
	}
	sb.WriteString("\r\n")

	if _, err := io.WriteString(conn, sb.String()); err != nil {
		conn.Close()
		return nil, fmt.Errorf("wsConnect: write handshake: %w", err)
	}

	r := bufio.NewReaderSize(conn, 65536)

	statusLine, err := r.ReadString('\n')
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("wsConnect: read status line: %w", err)
	}
	if !strings.Contains(statusLine, "101") {
		conn.Close()
		return nil, fmt.Errorf("wsConnect: expected 101 Switching Protocols, got: %s", strings.TrimSpace(statusLine))
	}

	for {
		line, err := r.ReadString('\n')
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("wsConnect: drain headers: %w", err)
		}
		if strings.TrimSpace(line) == "" {
			break
		}
	}

	return &wsConn{conn: conn, r: r}, nil
}

func parseWsURL(rawURL string) (scheme, host, path string, err error) {
	switch {
	case strings.HasPrefix(rawURL, "wss://"):
		scheme, rawURL = "wss", rawURL[6:]
	case strings.HasPrefix(rawURL, "ws://"):
		scheme, rawURL = "ws", rawURL[5:]
	case strings.HasPrefix(rawURL, "https://"):
		scheme, rawURL = "wss", rawURL[8:]
	case strings.HasPrefix(rawURL, "http://"):
		scheme, rawURL = "ws", rawURL[7:]
	default:
		err = fmt.Errorf("parseWsURL: unsupported scheme in %q", rawURL)
		return
	}

	if idx := strings.Index(rawURL, "/"); idx >= 0 {
		host, path = rawURL[:idx], rawURL[idx:]
	} else {
		host, path = rawURL, "/"
	}

	if !strings.Contains(host, ":") {
		if scheme == "wss" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	return
}

func wsAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func (ws *wsConn) ReadFrame() (opcode byte, payload []byte, err error) {
	h0, err := ws.r.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	opcode = h0 & 0x0F

	h1, err := ws.r.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	masked := (h1 & 0x80) != 0
	payLen := uint64(h1 & 0x7F)

	switch payLen {
	case 126:
		var l uint16
		if err = binary.Read(ws.r, binary.BigEndian, &l); err != nil {
			return 0, nil, err
		}
		payLen = uint64(l)
	case 127:
		if err = binary.Read(ws.r, binary.BigEndian, &payLen); err != nil {
			return 0, nil, err
		}
	}

	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(ws.r, maskKey[:]); err != nil {
			return 0, nil, err
		}
	}

	if payLen > 0 {
		payload = make([]byte, payLen)
		if _, err = io.ReadFull(ws.r, payload); err != nil {
			return 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= maskKey[i%4]
			}
		}
	}
	return opcode, payload, nil
}

func (ws *wsConn) WriteFrame(opcode byte, payload []byte) error {
	payLen := len(payload)

	var header []byte
	header = append(header, 0x80|opcode)

	switch {
	case payLen <= 125:
		header = append(header, 0x80|byte(payLen))
	case payLen <= 65535:
		header = append(header, 0x80|126)
		header = append(header, byte(payLen>>8), byte(payLen))
	default:
		header = append(header, 0x80|127)
		for i := 7; i >= 0; i-- {
			header = append(header, byte(payLen>>(uint(i)*8)))
		}
	}

	var maskKey [4]byte
	if _, err := rand.Read(maskKey[:]); err != nil {
		return fmt.Errorf("wsConn.WriteFrame: generate mask: %w", err)
	}
	header = append(header, maskKey[:]...)

	masked := make([]byte, payLen)
	for i, b := range payload {
		masked[i] = b ^ maskKey[i%4]
	}

	frame := append(header, masked...)
	_, err := ws.conn.Write(frame)
	return err
}

func (ws *wsConn) SendPong(payload []byte) error {
	return ws.WriteFrame(0xA, payload)
}

func (ws *wsConn) Close() {
	_ = ws.WriteFrame(0x8, []byte{})
	_ = ws.conn.Close()
}
