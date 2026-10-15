package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	protocolVersion       = "v1"
	serviceVersion        = "0.2.0"
	maxRequestBytes       = 512 << 10
	maxSignalBytes        = 256 << 10
	maxEventsPerDevice    = 256
	maxRegisteredDevices  = 100_000
	maxActiveSessions     = 10_000
	maxFileTransferBytes  = int64(1 << 30)
	pendingSessionTTL     = 90 * time.Second
	activeSessionTTL      = 24 * time.Hour
	deviceOnlineThreshold = 60 * time.Second
)

var (
	legacyDeviceIDPattern = regexp.MustCompile(`^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$`)
	deviceIDPattern       = regexp.MustCompile(`^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$`)
	sessionIDPattern      = regexp.MustCompile(`^[a-f0-9]{32}$`)
	publicKeyPattern      = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

type Permission string

const (
	PermissionView      Permission = "view"
	PermissionFiles     Permission = "files"
	PermissionClipboard Permission = "clipboard"
	PermissionInput     Permission = "input"
	PermissionAudio     Permission = "audio"
)

var supportedPermissions = map[Permission]bool{
	PermissionView:      true,
	PermissionFiles:     true,
	PermissionClipboard: true,
	PermissionInput:     true,
	PermissionAudio:     true,
}

type DeviceRecord struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	PublicKey    string    `json:"publicKey"`
	Platform     string    `json:"platform"`
	AppVersion   string    `json:"appVersion"`
	RegisteredAt time.Time `json:"registeredAt"`
	Revoked      bool      `json:"revoked,omitempty"`

	// LastSeen is process-local presence and is deliberately not persisted.
	LastSeen time.Time `json:"-"`
}

type DeviceSummary struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	PublicKey  string    `json:"publicKey"`
	Platform   string    `json:"platform"`
	AppVersion string    `json:"appVersion"`
	Online     bool      `json:"online"`
	LastSeenAt *time.Time `json:"lastSeenAt,omitempty"`
}

type Session struct {
	ID                   string       `json:"id"`
	FromDeviceID         string       `json:"fromDeviceId"`
	ToDeviceID           string       `json:"toDeviceId"`
	RequestedPermissions []Permission `json:"requestedPermissions"`
	Permissions          []Permission `json:"permissions,omitempty"`
	Status               string       `json:"status"`
	CreatedAt            time.Time    `json:"createdAt"`
	ExpiresAt            time.Time    `json:"expiresAt"`
}

type SignalMessage struct {
	FromDeviceID string          `json:"fromDeviceId"`
	Type         string          `json:"type"`
	Payload      json.RawMessage `json:"payload"`
	Signature    string          `json:"signature"`
}

type ServerEvent struct {
	Sequence  uint64         `json:"sequence"`
	Type      string         `json:"type"`
	SessionID string         `json:"sessionId,omitempty"`
	Session   *Session       `json:"session,omitempty"`
	Peer      *DeviceSummary `json:"peer,omitempty"`
	Message   *SignalMessage `json:"message,omitempty"`
	Reason    string         `json:"reason,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
}

type EventBatch struct {
	Cursor   uint64        `json:"cursor"`
	Events   []ServerEvent `json:"events"`
	Overflow bool          `json:"overflow,omitempty"`
}

type ICEConfiguration struct {
	ICEServers []ICEServer `json:"iceServers"`
}

type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type healthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Version string `json:"version"`
}

type apiError struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func validDeviceID(value string) bool {
	return deviceIDPattern.MatchString(value) || legacyDeviceIDPattern.MatchString(value)
}

func validSessionID(value string) bool {
	return sessionIDPattern.MatchString(value)
}

func decodePublicKey(encoded string) (ed25519.PublicKey, error) {
	if !publicKeyPattern.MatchString(encoded) {
		return nil, errors.New("invalid public key encoding")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		return nil, errors.New("invalid public key")
	}
	return ed25519.PublicKey(decoded), nil
}

func deviceIDFromPublicKey(publicKey string) string {
	digest := sha256.Sum256([]byte(publicKey))
	hexValue := strings.ToUpper(hex.EncodeToString(digest[:16]))
	return fmt.Sprintf("%s-%s-%s-%s", hexValue[0:8], hexValue[8:16], hexValue[16:24], hexValue[24:32])
}

func validateDisplayName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 80 {
		return "", errors.New("device name must contain 1 to 80 bytes")
	}
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			return "", errors.New("device name contains a control character")
		}
	}
	return value, nil
}

func validatePermissions(values []Permission, requireView bool) ([]Permission, error) {
	if len(values) == 0 || len(values) > len(supportedPermissions) {
		return nil, errors.New("select one or more supported permissions")
	}
	seen := make(map[Permission]bool, len(values))
	out := make([]Permission, 0, len(values))
	for _, value := range values {
		if !supportedPermissions[value] {
			return nil, fmt.Errorf("unsupported permission %q", value)
		}
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	if requireView && !seen[PermissionView] {
		return nil, errors.New("view permission is required")
	}
	return out, nil
}

func isSubsetPermissions(selected, requested []Permission) bool {
	allowed := make(map[Permission]bool, len(requested))
	for _, permission := range requested {
		allowed[permission] = true
	}
	for _, permission := range selected {
		if !allowed[permission] {
			return false
		}
	}
	return true
}

func peerSignalCanonical(sessionID, fromDeviceID, messageType string, payload json.RawMessage) []byte {
	digest := sha256.Sum256(payload)
	return []byte(fmt.Sprintf("opendesk-peer-signal-v1\n%s\n%s\n%s\n%x", sessionID, fromDeviceID, messageType, digest))
}

func validSignalPayload(messageType string, payload json.RawMessage) error {
	if len(payload) == 0 || len(payload) > maxSignalBytes {
		return errors.New("signal payload is empty or too large")
	}
	switch messageType {
	case "offer", "answer":
		var description struct {
			Type string `json:"type"`
			SDP  string `json:"sdp"`
		}
		if err := json.Unmarshal(payload, &description); err != nil {
			return errors.New("invalid session description")
		}
		if description.Type != messageType || len(description.SDP) > maxSignalBytes || !strings.Contains(description.SDP, "v=0") || !strings.Contains(description.SDP, "a=fingerprint:sha-256 ") || !strings.Contains(description.SDP, "a=ice-ufrag:") {
			return errors.New("session description is missing required WebRTC security fields")
		}
	case "hangup":
		var body struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(payload, &body); err != nil || len(body.Reason) > 120 {
			return errors.New("invalid hangup message")
		}
	default:
		return errors.New("unsupported signaling message type")
	}
	return nil
}

func cloneSession(session *Session) *Session {
	if session == nil {
		return nil
	}
	copy := *session
	copy.RequestedPermissions = append([]Permission(nil), session.RequestedPermissions...)
	copy.Permissions = append([]Permission(nil), session.Permissions...)
	return &copy
}

func jsonBodyHash(body []byte) string {
	digest := sha256.Sum256(body)
	return fmt.Sprintf("%x", digest)
}

func canonicalRequest(method, requestURI string, body []byte, nonce string) []byte {
	return []byte(fmt.Sprintf("opendesk-signaling-v1\n%s\n%s\n%s\n%s", method, requestURI, jsonBodyHash(body), nonce))
}

func decodeRawURLSignature(value string) ([]byte, error) {
	if value == "" || strings.Contains(value, "=") {
		return nil, errors.New("invalid signature encoding")
	}
	signature, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return nil, errors.New("invalid signature")
	}
	return signature, nil
}

func marshalCanonical(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func constantTimeStringEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	var result byte
	for index := range left {
		result |= left[index] ^ right[index]
	}
	return result == 0
}
