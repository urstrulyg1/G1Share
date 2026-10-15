package main

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type apiFault struct {
	Status  int
	Code    string
	Message string
}

func (fault *apiFault) Error() string { return fault.Message }

func newFault(status int, code, message string) *apiFault {
	return &apiFault{Status: status, Code: code, Message: message}
}

type challengeRecord struct {
	DeviceID  string
	ExpiresAt time.Time
}

type rateState struct {
	WindowStarted time.Time
	Count         int
}

type persistedRegistry struct {
	Version   int                     `json:"version"`
	Devices   map[string]DeviceRecord `json:"devices"`
	UpdatedAt time.Time               `json:"updatedAt"`
}

type turnSettings struct {
	STUNURLs      []string
	TURNURLs      []string
	SharedSecret  string
	Realm         string
	CredentialTTL time.Duration
}

type Broker struct {
	mu sync.Mutex

	devices       map[string]*DeviceRecord
	sessions      map[string]*Session
	events        map[string][]ServerEvent
	sequences     map[string]uint64
	notifications map[string]chan struct{}
	challenges    map[string]challengeRecord
	rates         map[string]rateState
	statePath     string
	turn          turnSettings
}

func newBroker(dataDir string, turn turnSettings) (*Broker, error) {
	broker := &Broker{
		devices:       make(map[string]*DeviceRecord),
		sessions:      make(map[string]*Session),
		events:        make(map[string][]ServerEvent),
		sequences:     make(map[string]uint64),
		notifications: make(map[string]chan struct{}),
		challenges:    make(map[string]challengeRecord),
		rates:         make(map[string]rateState),
		turn:          turn,
	}
	if dataDir == "" {
		return broker, nil
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	if err := os.Chmod(dataDir, 0o700); err != nil && runtimeIsUnix() {
		return nil, fmt.Errorf("secure data directory permissions: %w", err)
	}
	broker.statePath = filepath.Join(dataDir, "device-registry.json")
	if err := broker.loadRegistry(); err != nil {
		return nil, err
	}
	return broker, nil
}

// readiness reports whether this instance can serve authenticated traffic. It
// checks that the persistent registry directory is still writable, so an orchestrator
// stops routing to an instance whose registry can no longer be updated.
func (broker *Broker) readiness() error {
	if broker.statePath == "" {
		return nil
	}
	directory := filepath.Dir(broker.statePath)
	probe, err := os.CreateTemp(directory, ".readyz-*")
	if err != nil {
		return fmt.Errorf("data directory is not writable: %w", err)
	}
	name := probe.Name()
	_ = probe.Close()
	if err := os.Remove(name); err != nil {
		return fmt.Errorf("data directory cleanup failed: %w", err)
	}
	return nil
}

func runtimeIsUnix() bool {
	return filepath.Separator == '/'
}

func (broker *Broker) loadRegistry() error {
	data, err := os.ReadFile(broker.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read device registry: %w", err)
	}
	if len(data) > 32<<20 {
		return errors.New("device registry exceeds the 32 MiB safety limit")
	}
	var state persistedRegistry
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("device registry is invalid; refusing to start: %w", err)
	}
	if state.Version != 1 || state.Devices == nil || len(state.Devices) > maxRegisteredDevices {
		return errors.New("device registry has an unsupported version or invalid device count")
	}
	for id, record := range state.Devices {
		if !validDeviceID(id) || record.ID != id {
			return fmt.Errorf("device registry contains invalid identifier %q", id)
		}
		if _, err := decodePublicKey(record.PublicKey); err != nil {
			return fmt.Errorf("device registry contains an invalid key for %q", id)
		}
		if _, err := validateDisplayName(record.Name); err != nil {
			return fmt.Errorf("device registry contains an invalid name for %q", id)
		}
		copy := record
		copy.LastSeen = time.Time{}
		broker.devices[id] = &copy
	}
	return nil
}

func (broker *Broker) persistRegistryLocked() error {
	if broker.statePath == "" {
		return nil
	}
	devices := make(map[string]DeviceRecord, len(broker.devices))
	for id, record := range broker.devices {
		copy := *record
		copy.LastSeen = time.Time{}
		devices[id] = copy
	}
	state := persistedRegistry{Version: 1, Devices: devices, UpdatedAt: time.Now().UTC()}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode device registry: %w", err)
	}
	temporary := broker.statePath + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create registry update: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("write registry update: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("sync registry update: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("close registry update: %w", err)
	}
	if err := os.Chmod(temporary, 0o600); err != nil && runtimeIsUnix() {
		_ = os.Remove(temporary)
		return fmt.Errorf("set registry permissions: %w", err)
	}
	if err := os.Rename(temporary, broker.statePath); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace device registry: %w", err)
	}
	return nil
}

func (broker *Broker) issueChallenge(deviceID, rateKey string) (string, time.Time, *apiFault) {
	if !validDeviceID(deviceID) {
		return "", time.Time{}, newFault(400, "invalid_device_id", "Device ID is invalid.")
	}
	if !broker.allowRate("challenge:"+rateKey, 120, time.Minute) {
		return "", time.Time{}, newFault(429, "rate_limited", "Too many authentication challenges. Wait a minute and try again.")
	}
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", time.Time{}, newFault(500, "internal_error", "Could not create an authentication challenge.")
	}
	nonce := base64.RawURLEncoding.EncodeToString(buffer)
	expiresAt := time.Now().Add(30 * time.Second)
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if len(broker.challenges) > 20_000 {
		for key, challenge := range broker.challenges {
			if time.Now().After(challenge.ExpiresAt) {
				delete(broker.challenges, key)
			}
		}
		if len(broker.challenges) > 20_000 {
			return "", time.Time{}, newFault(503, "busy", "Authentication service is temporarily busy.")
		}
	}
	broker.challenges[nonce] = challengeRecord{DeviceID: deviceID, ExpiresAt: expiresAt}
	return nonce, expiresAt, nil
}

func (broker *Broker) consumeChallenge(nonce string) (challengeRecord, bool) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	challenge, found := broker.challenges[nonce]
	delete(broker.challenges, nonce)
	if !found || time.Now().After(challenge.ExpiresAt) {
		return challengeRecord{}, false
	}
	return challenge, true
}

func (broker *Broker) allowRate(key string, limit int, window time.Duration) bool {
	now := time.Now()
	broker.mu.Lock()
	defer broker.mu.Unlock()
	state := broker.rates[key]
	if state.WindowStarted.IsZero() || now.Sub(state.WindowStarted) >= window {
		broker.rates[key] = rateState{WindowStarted: now, Count: 1}
		return true
	}
	if state.Count >= limit {
		return false
	}
	state.Count++
	broker.rates[key] = state
	if len(broker.rates) > 50_000 {
		for rateKey, value := range broker.rates {
			if now.Sub(value.WindowStarted) >= 2*window {
				delete(broker.rates, rateKey)
			}
		}
	}
	return true
}

func (broker *Broker) registeredDevice(id string) (*DeviceRecord, bool) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	record, found := broker.devices[id]
	if !found || record.Revoked {
		return nil, false
	}
	copy := *record
	return &copy, true
}

func (broker *Broker) touchDevice(id string) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if record, found := broker.devices[id]; found && !record.Revoked {
		record.LastSeen = time.Now().UTC()
	}
}

func (broker *Broker) registerDevice(id, publicKey, name, platform, appVersion string) (DeviceSummary, *apiFault) {
	if !validDeviceID(id) {
		return DeviceSummary{}, newFault(400, "invalid_device_id", "Device ID is invalid.")
	}
	if _, err := decodePublicKey(publicKey); err != nil {
		return DeviceSummary{}, newFault(400, "invalid_public_key", "Device public key is invalid.")
	}
	if deviceIDPattern.MatchString(id) && !constantTimeStringEqual(id, deviceIDFromPublicKey(publicKey)) {
		return DeviceSummary{}, newFault(400, "device_key_mismatch", "The modern device ID does not match its identity key.")
	}
	name, err := validateDisplayName(name)
	if err != nil {
		return DeviceSummary{}, newFault(400, "invalid_name", err.Error())
	}
	platform = strings.TrimSpace(platform)
	appVersion = strings.TrimSpace(appVersion)
	if len(platform) == 0 || len(platform) > 32 || len(appVersion) == 0 || len(appVersion) > 64 {
		return DeviceSummary{}, newFault(400, "invalid_device_info", "Platform and version information are invalid.")
	}

	broker.mu.Lock()
	defer broker.mu.Unlock()
	record, exists := broker.devices[id]
	if exists {
		if record.Revoked {
			return DeviceSummary{}, newFault(403, "device_revoked", "This device identity has been revoked. Create a new local identity to register again.")
		}
		if !constantTimeStringEqual(record.PublicKey, publicKey) {
			return DeviceSummary{}, newFault(409, "identity_conflict", "This device ID is already registered to a different public key.")
		}
		record.Name = name
		record.Platform = platform
		record.AppVersion = appVersion
		record.LastSeen = time.Now().UTC()
	} else {
		if len(broker.devices) >= maxRegisteredDevices {
			return DeviceSummary{}, newFault(503, "registry_full", "This signaling service has reached its registered-device limit.")
		}
		record = &DeviceRecord{ID: id, Name: name, PublicKey: publicKey, Platform: platform, AppVersion: appVersion, RegisteredAt: time.Now().UTC(), LastSeen: time.Now().UTC()}
		broker.devices[id] = record
	}
	if err := broker.persistRegistryLocked(); err != nil {
		if !exists {
			delete(broker.devices, id)
		}
		return DeviceSummary{}, newFault(500, "registry_write_failed", "The service could not persist the device registry.")
	}
	return summaryFor(record, time.Now()), nil
}

func (broker *Broker) renameDevice(id, name string) (DeviceSummary, *apiFault) {
	name, err := validateDisplayName(name)
	if err != nil {
		return DeviceSummary{}, newFault(400, "invalid_name", err.Error())
	}
	broker.mu.Lock()
	defer broker.mu.Unlock()
	record, found := broker.devices[id]
	if !found || record.Revoked {
		return DeviceSummary{}, newFault(404, "device_not_found", "Device identity was not found.")
	}
	oldName := record.Name
	record.Name = name
	if err := broker.persistRegistryLocked(); err != nil {
		record.Name = oldName
		return DeviceSummary{}, newFault(500, "registry_write_failed", "The service could not persist the device name.")
	}
	return summaryFor(record, time.Now()), nil
}

func (broker *Broker) revokeDevice(id string) *apiFault {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	record, found := broker.devices[id]
	if !found || record.Revoked {
		return newFault(404, "device_not_found", "Device identity was not found or has already been revoked.")
	}
	record.Revoked = true
	record.LastSeen = time.Time{}
	if err := broker.persistRegistryLocked(); err != nil {
		record.Revoked = false
		return newFault(500, "registry_write_failed", "The service could not persist device revocation.")
	}
	for sessionID, session := range broker.sessions {
		if session.FromDeviceID == id || session.ToDeviceID == id {
			if session.Status == "pending" || session.Status == "accepted" {
				session.Status = "closed"
				session.ExpiresAt = time.Now().UTC()
				peer := session.ToDeviceID
				if peer == id {
					peer = session.FromDeviceID
				}
				broker.emitLocked(peer, ServerEvent{Type: "session.closed", SessionID: sessionID, Session: cloneSession(session), Reason: "A device identity was revoked."})
			}
		}
	}
	return nil
}

func summaryFor(record *DeviceRecord, now time.Time) DeviceSummary {
	var lastSeen *time.Time
	if !record.LastSeen.IsZero() {
		observed := record.LastSeen
		lastSeen = &observed
	}
	return DeviceSummary{
		ID:         record.ID,
		Name:       record.Name,
		PublicKey:  record.PublicKey,
		Platform:   record.Platform,
		AppVersion: record.AppVersion,
		Online:     lastSeen != nil && now.Sub(*lastSeen) <= deviceOnlineThreshold,
		LastSeenAt: lastSeen,
	}
}

func (broker *Broker) getDevice(id string) (DeviceSummary, *apiFault) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	record, found := broker.devices[id]
	if !found || record.Revoked {
		return DeviceSummary{}, newFault(404, "device_not_found", "No active device is registered with that ID.")
	}
	return summaryFor(record, time.Now()), nil
}

func (broker *Broker) createSession(fromID, toID string, requested []Permission) (*Session, DeviceSummary, *apiFault) {
	if fromID == toID {
		return nil, DeviceSummary{}, newFault(400, "same_device", "A device cannot start a session with itself.")
	}
	permissions, err := validatePermissions(requested, true)
	if err != nil {
		return nil, DeviceSummary{}, newFault(400, "invalid_permissions", err.Error())
	}
	broker.mu.Lock()
	defer broker.mu.Unlock()
	from, fromExists := broker.devices[fromID]
	target, targetExists := broker.devices[toID]
	if !fromExists || from.Revoked {
		return nil, DeviceSummary{}, newFault(401, "device_not_registered", "Register this device with the signaling service first.")
	}
	if !targetExists || target.Revoked {
		return nil, DeviceSummary{}, newFault(404, "device_not_found", "No active device is registered with that ID.")
	}
	now := time.Now().UTC()
	if now.Sub(target.LastSeen) > deviceOnlineThreshold {
		return nil, DeviceSummary{}, newFault(409, "device_offline", "The target device is offline. Confirm that OpenDesk is running and connected to the same signaling service.")
	}
	active := 0
	for _, existing := range broker.sessions {
		if existing.Status == "pending" || existing.Status == "accepted" {
			active++
			if (existing.FromDeviceID == fromID && existing.ToDeviceID == toID) || (existing.FromDeviceID == toID && existing.ToDeviceID == fromID) {
				return nil, DeviceSummary{}, newFault(409, "duplicate_session", "A session between these devices is already active or awaiting approval.")
			}
		}
	}
	if active >= maxActiveSessions {
		return nil, DeviceSummary{}, newFault(503, "session_limit", "The signaling service is at its active-session limit.")
	}
	sessionID, err := randomHex(16)
	if err != nil {
		return nil, DeviceSummary{}, newFault(500, "internal_error", "Could not create a session identifier.")
	}
	session := &Session{
		ID:                   sessionID,
		FromDeviceID:         fromID,
		ToDeviceID:           toID,
		RequestedPermissions: append([]Permission(nil), permissions...),
		Status:               "pending",
		CreatedAt:            now,
		ExpiresAt:            now.Add(pendingSessionTTL),
	}
	broker.sessions[sessionID] = session
	broker.emitLocked(toID, ServerEvent{Type: "session.request", SessionID: sessionID, Session: cloneSession(session), Peer: ptrSummary(summaryFor(from, now))})
	return cloneSession(session), summaryFor(target, now), nil
}

func (broker *Broker) decideSession(sessionID, actorID string, accepted bool, selected []Permission) (*Session, *apiFault) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	session, found := broker.sessions[sessionID]
	if !found {
		return nil, newFault(404, "session_not_found", "Session was not found or has expired.")
	}
	if session.ToDeviceID != actorID {
		return nil, newFault(403, "not_session_host", "Only the requested device can approve or reject this session.")
	}
	if session.Status != "pending" {
		return nil, newFault(409, "session_not_pending", "This session request is no longer awaiting approval.")
	}
	if time.Now().After(session.ExpiresAt) {
		session.Status = "expired"
		return nil, newFault(410, "session_expired", "This session request expired before approval.")
	}
	if accepted {
		permissions, err := validatePermissions(selected, true)
		if err != nil || !isSubsetPermissions(permissions, session.RequestedPermissions) {
			return nil, newFault(400, "invalid_permissions", "Approved permissions must be selected from the request and include screen viewing.")
		}
		session.Permissions = permissions
		session.Status = "accepted"
		session.ExpiresAt = session.CreatedAt.Add(activeSessionTTL)
		broker.emitLocked(session.FromDeviceID, ServerEvent{Type: "session.accepted", SessionID: session.ID, Session: cloneSession(session), Peer: ptrSummary(summaryFor(broker.devices[session.ToDeviceID], time.Now()))})
	} else {
		session.Status = "rejected"
		session.ExpiresAt = time.Now().UTC()
		broker.emitLocked(session.FromDeviceID, ServerEvent{Type: "session.rejected", SessionID: session.ID, Session: cloneSession(session), Peer: ptrSummary(summaryFor(broker.devices[session.ToDeviceID], time.Now())), Reason: "The remote user rejected the request."})
	}
	return cloneSession(session), nil
}

func (broker *Broker) getSession(sessionID, actorID string) (*Session, DeviceSummary, *apiFault) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	session, found := broker.sessions[sessionID]
	if !found || (session.FromDeviceID != actorID && session.ToDeviceID != actorID) {
		return nil, DeviceSummary{}, newFault(404, "session_not_found", "Session was not found.")
	}
	peerID := session.ToDeviceID
	if peerID == actorID {
		peerID = session.FromDeviceID
	}
	peer := broker.devices[peerID]
	return cloneSession(session), summaryFor(peer, time.Now()), nil
}

func (broker *Broker) forwardSignal(sessionID, actorID string, message SignalMessage) *apiFault {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	session, found := broker.sessions[sessionID]
	if !found || (session.FromDeviceID != actorID && session.ToDeviceID != actorID) {
		return newFault(404, "session_not_found", "Session was not found.")
	}
	if message.FromDeviceID != actorID {
		return newFault(403, "sender_mismatch", "Signal sender does not match the authenticated device.")
	}
	if session.Status != "accepted" {
		return newFault(409, "session_not_accepted", "Signaling is allowed only after the remote user approves the session.")
	}
	if time.Now().After(session.ExpiresAt) {
		return newFault(410, "session_expired", "This session has expired. Start a new session request.")
	}
	if err := validSignalPayload(message.Type, message.Payload); err != nil {
		return newFault(400, "invalid_signal", err.Error())
	}
	if message.Type == "offer" && actorID != session.ToDeviceID {
		return newFault(403, "invalid_signal_role", "The screen-sharing device must initiate the WebRTC offer.")
	}
	if message.Type == "answer" && actorID != session.FromDeviceID {
		return newFault(403, "invalid_signal_role", "Only the requesting viewer can answer the offer.")
	}
	record := broker.devices[actorID]
	signature, err := decodeRawURLSignature(message.Signature)
	if err != nil || record == nil {
		return newFault(401, "invalid_peer_signature", "The peer signal could not be authenticated.")
	}
	publicKey, err := decodePublicKey(record.PublicKey)
	if err != nil || !ed25519Verify(publicKey, peerSignalCanonical(sessionID, actorID, message.Type, message.Payload), signature) {
		return newFault(401, "invalid_peer_signature", "The peer signal could not be authenticated.")
	}
	if message.Type == "hangup" {
		session.Status = "closed"
		session.ExpiresAt = time.Now().UTC()
		peerID := session.FromDeviceID
		if peerID == actorID {
			peerID = session.ToDeviceID
		}
		broker.emitLocked(peerID, ServerEvent{Type: "session.closed", SessionID: session.ID, Session: cloneSession(session), Peer: ptrSummary(summaryFor(record, time.Now())), Reason: "The remote user disconnected."})
		return nil
	}
	peerID := session.FromDeviceID
	if peerID == actorID {
		peerID = session.ToDeviceID
	}
	copy := message
	copy.Payload = append(json.RawMessage(nil), message.Payload...)
	broker.emitLocked(peerID, ServerEvent{Type: "signal", SessionID: session.ID, Message: &copy, Peer: ptrSummary(summaryFor(record, time.Now()))})
	return nil
}

func ed25519Verify(publicKey []byte, message, signature []byte) bool {
	return len(publicKey) == 32 && len(signature) == 64 && ed25519.Verify(publicKey, message, signature)
}

func (broker *Broker) closeSession(sessionID, actorID, reason string) (*Session, *apiFault) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	session, found := broker.sessions[sessionID]
	if !found || (session.FromDeviceID != actorID && session.ToDeviceID != actorID) {
		return nil, newFault(404, "session_not_found", "Session was not found.")
	}
	if session.Status == "closed" || session.Status == "rejected" || session.Status == "expired" {
		return cloneSession(session), nil
	}
	session.Status = "closed"
	session.ExpiresAt = time.Now().UTC()
	peerID := session.FromDeviceID
	if peerID == actorID {
		peerID = session.ToDeviceID
	}
	if len(reason) > 120 {
		reason = "The remote user disconnected."
	}
	broker.emitLocked(peerID, ServerEvent{Type: "session.closed", SessionID: session.ID, Session: cloneSession(session), Reason: reason})
	return cloneSession(session), nil
}

func (broker *Broker) pollEvents(ctx context.Context, deviceID string, cursor uint64, wait time.Duration) (EventBatch, error) {
	if wait < 0 {
		wait = 0
	}
	if wait > 25*time.Second {
		wait = 25 * time.Second
	}
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		broker.mu.Lock()
		channel := broker.notificationLocked(deviceID)
		stored := broker.events[deviceID]
		batch := EventBatch{Cursor: cursor, Events: []ServerEvent{}}
		if len(stored) > 0 && cursor+1 < stored[0].Sequence {
			batch.Overflow = true
			batch.Cursor = stored[0].Sequence - 1
			cursor = batch.Cursor
		}
		for _, event := range stored {
			if event.Sequence > cursor {
				batch.Events = append(batch.Events, event)
				batch.Cursor = event.Sequence
			}
		}
		if len(batch.Events) > 0 || wait == 0 {
			if len(batch.Events) == 0 && broker.sequences[deviceID] > batch.Cursor {
				batch.Cursor = broker.sequences[deviceID]
			}
			broker.mu.Unlock()
			return batch, nil
		}
		broker.mu.Unlock()

		select {
		case <-channel:
			continue
		case <-deadline.C:
			broker.mu.Lock()
			if broker.sequences[deviceID] > cursor {
				cursor = broker.sequences[deviceID]
			}
			broker.mu.Unlock()
			return EventBatch{Cursor: cursor, Events: []ServerEvent{}}, nil
		case <-ctx.Done():
			return EventBatch{}, ctx.Err()
		}
	}
}

func (broker *Broker) notificationLocked(deviceID string) chan struct{} {
	channel, found := broker.notifications[deviceID]
	if !found {
		channel = make(chan struct{}, 1)
		broker.notifications[deviceID] = channel
	}
	return channel
}

func (broker *Broker) emitLocked(deviceID string, event ServerEvent) {
	broker.sequences[deviceID]++
	event.Sequence = broker.sequences[deviceID]
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	list := append(broker.events[deviceID], event)
	if len(list) > maxEventsPerDevice {
		list = append([]ServerEvent(nil), list[len(list)-maxEventsPerDevice:]...)
	}
	broker.events[deviceID] = list
	channel := broker.notificationLocked(deviceID)
	select {
	case channel <- struct{}{}:
	default:
	}
}

func (broker *Broker) iceConfiguration(deviceID string, now time.Time) ICEConfiguration {
	configuration := ICEConfiguration{ICEServers: make([]ICEServer, 0, len(broker.turn.STUNURLs)+1)}
	if len(broker.turn.STUNURLs) > 0 {
		configuration.ICEServers = append(configuration.ICEServers, ICEServer{URLs: append([]string(nil), broker.turn.STUNURLs...)})
	}
	if len(broker.turn.TURNURLs) > 0 && broker.turn.SharedSecret != "" {
		ttl := broker.turn.CredentialTTL
		if ttl < time.Minute || ttl > time.Hour {
			ttl = 10 * time.Minute
		}
		expires := now.Add(ttl).Unix()
		username := fmt.Sprintf("%d:%s", expires, deviceID)
		mac := hmac.New(sha1.New, []byte(broker.turn.SharedSecret))
		_, _ = mac.Write([]byte(username))
		credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		configuration.ICEServers = append(configuration.ICEServers, ICEServer{URLs: append([]string(nil), broker.turn.TURNURLs...), Username: username, Credential: credential})
	}
	return configuration
}

func (broker *Broker) summaryCounts() (int, int, int) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	devices := 0
	for _, record := range broker.devices {
		if !record.Revoked {
			devices++
		}
	}
	activeSessions := 0
	for _, session := range broker.sessions {
		if session.Status == "pending" || session.Status == "accepted" {
			activeSessions++
		}
	}
	return devices, activeSessions, len(broker.events)
}

func (broker *Broker) cleanupExpired() {
	now := time.Now().UTC()
	broker.mu.Lock()
	defer broker.mu.Unlock()
	for sessionID, session := range broker.sessions {
		if session.Status != "pending" && session.Status != "accepted" {
			if now.Sub(session.ExpiresAt) > 48*time.Hour {
				delete(broker.sessions, sessionID)
			}
			continue
		}
		if now.Before(session.ExpiresAt) {
			continue
		}
		session.Status = "expired"
		peerID := session.FromDeviceID
		if peerID == "" {
			continue
		}
		broker.emitLocked(peerID, ServerEvent{Type: "session.expired", SessionID: session.ID, Session: cloneSession(session), Reason: "The session expired."})
		if session.ToDeviceID != peerID {
			broker.emitLocked(session.ToDeviceID, ServerEvent{Type: "session.expired", SessionID: session.ID, Session: cloneSession(session), Reason: "The session expired."})
		}
	}
	for nonce, challenge := range broker.challenges {
		if now.After(challenge.ExpiresAt) {
			delete(broker.challenges, nonce)
		}
	}
	for key, state := range broker.rates {
		if now.Sub(state.WindowStarted) > 2*time.Minute {
			delete(broker.rates, key)
		}
	}
}

func (broker *Broker) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			broker.cleanupExpired()
		}
	}
}

func (broker *Broker) sortedDeviceIDs() []string {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	ids := make([]string, 0, len(broker.devices))
	for id, record := range broker.devices {
		if !record.Revoked {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func ptrSummary(summary DeviceSummary) *DeviceSummary { return &summary }

func randomHex(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
