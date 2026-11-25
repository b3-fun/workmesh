import Foundation

// Wire types mirroring the daemon's loopback JSON (packages/core + daemon/server.ts).
// Field names match the JSON exactly so no CodingKeys are needed. Fields added
// after 0.4 are optional so the app still decodes an older daemon.

struct SlackStatus: Decodable, Equatable {
    let text: String
    let emoji: String
    let expirationSec: Int
}

struct AgentSession: Decodable, Identifiable, Equatable {
    let key: String
    let source: String
    let sessionId: String
    let state: String // "working" | "waiting" | "idle"
    let activity: String?
    let project: String?
    let agents: Int?
    let phase: String?
    /// Working only on its own background shells/subagents.
    let background: Bool?
    /// Full working directory (local only).
    let cwd: String?
    /// Agent's own session name, e.g. Claude Code's "documents-07".
    let name: String?
    let startedAt: Double
    let updatedAt: Double
    /// When the current state began (epoch ms).
    let stateSince: Double?
    /// Agents running under this session beyond itself ("+N").
    let subagents: Int?
    /// Set when this session's agents are already counted in another row.
    let foldedInto: String?

    var id: String { key }
}

struct Snapshot: Decodable {
    let sessions: [AgentSession]
    let working: Int
    let waiting: Int
    let idle: Int
    let total: Int
    let agentCount: Int?
    let latestActivity: String?
}

struct Ownership: Decodable, Equatable {
    let backedOff: Bool
    let savedPrior: Bool
    let policy: String // "respect" | "overwrite"
}

struct DaemonState: Decodable {
    let snapshot: Snapshot
    let formatted: SlackStatus?
    let paused: Bool
    /// When a snooze ends (epoch ms); nil for an open-ended pause.
    let pausedUntil: Double?
    let ownership: Ownership
    let lastError: String?
}

struct DaemonConfig: Decodable {
    let mode: String
    let relayUrl: String
    let port: Int
    let granularity: String
    let statusPolicy: String
    let showProject: Bool
    let repoPrefix: Bool
    let statusTtlSec: Int
    let debounceMs: Int
}

/// The list sections, in display order. A direct read of the daemon's fields.
enum SessionGroup: CaseIterable {
    case needsYou, working, background, idle

    static func of(_ s: AgentSession) -> SessionGroup {
        switch s.state {
        case "waiting": return .needsYou
        case "working": return s.background == true ? .background : .working
        default: return .idle
        }
    }

    var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .working: return "Working"
        case .background: return "Background"
        case .idle: return "Idle"
        }
    }
}

/// What the menu bar icon shows. "Needs you" wins over everything; otherwise
/// the working count, drawn filled while syncing to Slack and outlined while
/// sync is off (paused, snoozed, or standing down for your own status).
enum BlipState: Equatable {
    case unreachable // no daemon / can't connect
    case idle(onAir: Bool) // daemon up, nothing running
    case working(Int, onAir: Bool) // agents working (count = fan-out aware agentCount)
    case needsYou(Int) // sessions blocked on the human

    static func from(state: DaemonState?) -> BlipState {
        guard let s = state else { return .unreachable }
        let onAir = !s.paused && !s.ownership.backedOff
        if s.snapshot.waiting > 0 { return .needsYou(s.snapshot.waiting) }
        let n = s.snapshot.agentCount ?? s.snapshot.working
        if s.snapshot.working > 0 { return .working(max(n, 1), onAir: onAir) }
        return .idle(onAir: onAir)
    }
}

enum SnoozePreset: String, CaseIterable {
    case thirtyMinutes = "30m"
    case oneHour = "1h"
    case tomorrow = "tomorrow"

    var title: String {
        switch self {
        case .thirtyMinutes: return "For 30 Minutes"
        case .oneHour: return "For 1 Hour"
        case .tomorrow: return "Until Tomorrow"
        }
    }
}

// MARK: - Team (GET /team, v0.5)
//
// The daemon polls the hub, caches the team view and answers on loopback; the
// app only reads it. Every field is optional on the wire, a field of the wrong
// type reads as absent, and a malformed person or session is dropped on its
// own, so an older or newer daemon never blanks the menu. A daemon without the
// endpoint (404) hides the team UI.

private extension KeyedDecodingContainer {
    /// The value, or nil when it's missing, null or of another type.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    func text(_ key: Key) -> String? {
        guard let s = lenient(String.self, key), !s.isEmpty else { return nil }
        return s
    }

    /// A non-negative count; fractional numbers round.
    func count(_ key: Key) -> Int {
        guard let d = lenient(Double.self, key), d.isFinite else { return 0 }
        return max(0, Int(d.rounded()))
    }

    /// The items that decode; the rest are dropped.
    func lossy<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
        (lenient([Lossy<T>].self, key) ?? []).compactMap(\.value)
    }
}

private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

struct TeamState: Decodable {
    let enabled: Bool
    let hubUrl: String?
    /// "Open board" target.
    let boardUrl: String?
    /// A display name for the hub, when the daemon sends one (else the host is shown).
    let hubName: String?
    /// This Mac's device id on the hub: needsMe items under it are this Mac's own sessions.
    let deviceId: String?
    /// This machine's sharing level: "conversation" or "metadata".
    let share: String?
    /// The last send to the hub succeeded.
    let connected: Bool?
    /// The hub rejected the device token: pairing again is the fix.
    let halted: Bool
    /// nil = not asked yet; false = the hub has no team view (an older hub).
    let available: Bool?
    /// Epoch ms of the daemon's last good team read.
    let fetchedAt: Double?
    let error: String?
    let pollMs: Double?
    /// Absent until the daemon's first good read.
    let team: TeamView?
    /// v1: holds on this Mac's agents and messages waiting for them (absent from older daemons).
    let coord: CoordState?

    private enum K: String, CodingKey {
        case enabled, hubUrl, boardUrl, hubName, deviceId, share, connected, halted, available, fetchedAt, error, pollMs, team, coord
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        enabled = c.lenient(Bool.self, .enabled) ?? false
        hubUrl = c.text(.hubUrl)
        boardUrl = c.text(.boardUrl)
        hubName = c.text(.hubName)
        deviceId = c.text(.deviceId)
        share = c.text(.share)
        connected = c.lenient(Bool.self, .connected)
        halted = c.lenient(Bool.self, .halted) ?? false
        available = c.lenient(Bool.self, .available)
        fetchedAt = c.lenient(Double.self, .fetchedAt)
        error = c.text(.error)
        pollMs = c.lenient(Double.self, .pollMs)
        team = c.lenient(TeamView.self, .team)
        coord = c.lenient(CoordState.self, .coord)
    }

    /// What the footer names: the daemon's hub name, else the host without a
    /// leading workmesh./bullpen./hub. label ("b3os.org").
    var hubLabel: String {
        if let hubName { return hubName }
        guard let host = hubUrl.flatMap({ URL(string: $0)?.host }) else { return "the hub" }
        let parts = host.split(separator: ".")
        if parts.count > 2, ["workmesh", "bullpen", "hub", "www"].contains(parts[0].lowercased()) {
            return parts.dropFirst().joined(separator: ".")
        }
        return host
    }

    var boardLink: URL? {
        guard let s = boardUrl ?? hubUrl, let url = URL(string: s),
              url.scheme == "https" || url.scheme == "http"
        else { return nil }
        return url
    }
}

// MARK: - Coordination (v1, inside GET /team)
//
// Holds a teammate put on this Mac's agents, and messages waiting for them (an
// agent gets its messages at its next tool call; these are the ones it hasn't
// reached yet). Read leniently, like the rest of /team.

struct CoordState: Decodable {
    /// nil = not synced yet; false = the hub has no coordination.
    let available: Bool?
    let holds: [CoordHold]
    let unread: [CoordMessage]

    private enum K: String, CodingKey { case available, holds, unread }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        available = c.lenient(Bool.self, .available)
        holds = c.lossy(CoordHold.self, .holds)
        unread = c.lossy(CoordMessage.self, .unread)
    }

    init(available: Bool?, holds: [CoordHold], unread: [CoordMessage]) {
        self.available = available
        self.holds = holds
        self.unread = unread
    }
}

struct CoordHold: Decodable, Identifiable {
    /// The held session's local key.
    let session: String
    let name: String?
    let by: String
    let reason: String?
    let since: Double?
    var id: String { session }

    private enum K: String, CodingKey { case session, name, by, reason, since }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let session = c.text(.session) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "hold without a session"))
        }
        self.session = session
        name = c.text(.name)
        by = c.text(.by) ?? "A teammate"
        reason = c.text(.reason)
        since = c.lenient(Double.self, .since)
    }
}

struct CoordMessage: Decodable, Identifiable {
    let id: String
    /// The recipient session's local key, and its name.
    let session: String?
    let name: String?
    let from: String
    let fromSession: String?
    let text: String
    let ts: Double?

    private enum K: String, CodingKey { case id, session, name, from, fromSession, text, ts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let id = c.text(.id), let text = c.text(.text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "message without id or text"))
        }
        self.id = id
        self.text = text
        session = c.text(.session)
        name = c.text(.name)
        from = c.text(.from) ?? "A teammate"
        fromSession = c.text(.fromSession)
        ts = c.lenient(Double.self, .ts)
    }
}

struct TeamView: Decodable {
    let me: TeamMe?
    let people: [TeamPerson]
    let needsMe: [TeamNeed]
    let sessions: [TeamSession]
    /// The hub's clock when it answered, so ages don't trust this Mac's clock.
    let serverNow: Double?

    private enum K: String, CodingKey { case me, people, needsMe, sessions, serverNow }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        me = c.lenient(TeamMe.self, .me)
        people = c.lossy(TeamPerson.self, .people)
        needsMe = c.lossy(TeamNeed.self, .needsMe)
        sessions = c.lossy(TeamSession.self, .sessions)
        serverNow = c.lenient(Double.self, .serverNow)
    }

    /// Me: by email when both sides have one, else by name.
    func isMe(_ p: TeamPerson) -> Bool {
        guard let me else { return false }
        if let a = me.email, let b = p.email { return a.caseInsensitiveCompare(b) == .orderedSame }
        guard let n = me.name else { return false }
        return n.caseInsensitiveCompare(p.name) == .orderedSame
    }

    /// Everyone but me: active agents first, then online, then the rest; by name within.
    var teammates: [TeamPerson] {
        people.filter { !isMe($0) }.sorted { a, b in
            a.rank == b.rank ? a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending : a.rank < b.rank
        }
    }

    /// A person's open sessions (ended ones left out): waiting, working, idle, offline.
    func sessions(of p: TeamPerson) -> [TeamSession] {
        sessions.filter { $0.owner == p.name && $0.state != "ended" }.sorted { a, b in
            a.rank == b.rank ? a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending : a.rank < b.rank
        }
    }
}

struct TeamMe: Decodable {
    let name: String?
    let email: String?
    let github: String?

    private enum K: String, CodingKey { case name, email, github }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        name = c.text(.name)
        email = c.text(.email)
        github = c.text(.github)
    }
}

struct TeamCounts: Equatable {
    var working = 0
    var waiting = 0
    var idle = 0
}

struct TeamPerson: Decodable, Identifiable {
    let name: String
    let email: String?
    let github: String?
    let online: Bool
    /// v0.10 (SPEC §24): the hub's presence, "online" | "reconnecting" | "asleep" | "offline"; nil from older hubs.
    let presence: String?
    let counts: TeamCounts

    var id: String { name }

    fileprivate var rank: Int {
        if counts.working + counts.waiting > 0 { return 0 }
        return online ? 1 : 2
    }

    private enum K: String, CodingKey { case name, email, github, online, presence, counts }
    private enum CountKeys: String, CodingKey { case working, waiting, idle }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let n = c.text(.name) else {
            throw DecodingError.keyNotFound(K.name, .init(codingPath: c.codingPath, debugDescription: "person without a name"))
        }
        name = n
        email = c.text(.email)
        github = c.text(.github)
        online = c.lenient(Bool.self, .online) ?? false
        let p = c.text(.presence)
        presence = ["online", "reconnecting", "asleep", "offline"].contains(p ?? "") ? p : nil
        if let cc = try? c.nestedContainer(keyedBy: CountKeys.self, forKey: .counts) {
            counts = TeamCounts(working: cc.count(.working), waiting: cc.count(.waiting), idle: cc.count(.idle))
        } else {
            counts = TeamCounts()
        }
    }
}

/// A session of mine waiting on me, as the hub sees it (any of my machines).
struct TeamNeed: Decodable {
    /// The hub key, "<deviceId>:<source>:<sessionId>".
    let session: String
    let reason: String?
    /// When the wait began (epoch ms, hub clock).
    let since: Double?
    let name: String?
    let source: String?
    let repo: String?
    let owner: String?

    private enum K: String, CodingKey { case session, reason, since, name, source, repo, owner }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let s = c.text(.session) else {
            throw DecodingError.keyNotFound(K.session, .init(codingPath: c.codingPath, debugDescription: "needsMe item without a session"))
        }
        session = s
        reason = c.text(.reason)
        since = c.lenient(Double.self, .since)
        name = c.text(.name)
        source = c.text(.source)
        repo = c.text(.repo)
        owner = c.text(.owner)
    }
}

struct TeamSession: Decodable, Identifiable {
    let key: String?
    let owner: String
    let name: String
    let source: String
    /// working | waiting | idle | ended | offline
    let state: String
    let now: String?
    let repo: String?
    let branch: String?
    let subagents: Int
    let stateSince: Double?

    var id: String { key ?? "\(owner)/\(source)/\(name)" }

    fileprivate var rank: Int {
        switch state {
        case "waiting": return 0
        case "working": return 1
        case "idle": return 2
        default: return 3
        }
    }

    private enum K: String, CodingKey { case key, owner, name, source, state, now, repo, branch, subagents, stateSince }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let o = c.text(.owner) else {
            throw DecodingError.keyNotFound(K.owner, .init(codingPath: c.codingPath, debugDescription: "session without an owner"))
        }
        owner = o
        key = c.text(.key)
        name = c.text(.name) ?? ""
        source = c.text(.source) ?? "other"
        state = c.text(.state) ?? "idle"
        now = c.text(.now)
        repo = c.text(.repo)
        branch = c.text(.branch)
        // A count; a hub that sends the subagents themselves counts its items.
        if let list = c.lenient([Lossy<String>].self, .subagents) {
            subagents = list.count
        } else {
            subagents = c.count(.subagents)
        }
        stateSince = c.lenient(Double.self, .stateSince)
    }
}

// MARK: - Needs you: local waiting sessions merged with the hub's needsMe

/// One wait on me, shown once: a local waiting session (with the hub's reason
/// when the hub lists it too), or a needsMe item from another of my machines.
struct NeedItem: Identifiable {
    let local: AgentSession?
    let remote: TeamNeed?
    /// "<source>:<sessionId>": the local key, or the hub key without its device id.
    let key: String
    /// When the wait began: the local session's clock when it's here, else the hub's.
    let since: Double

    var id: String { key }
    var isLocal: Bool { local != nil }
    var source: String { local?.source ?? remote?.source ?? "other" }
    var name: String? { local?.name ?? remote?.name }
    /// The hub's reason when it has one, else the local activity.
    var reason: String? { remote?.reason ?? local?.activity }
    var title: String {
        local?.project ?? remote?.repo.map(Self.repoName) ?? name ?? "An agent"
    }

    /// "b3-fun/workmesh" → "workmesh".
    static func repoName(_ repo: String) -> String {
        repo.split(separator: "/").last.map(String.init) ?? repo
    }

    /// Longest wait first. A needsMe item whose hub key ends with ":" + a local
    /// waiting session's key is that session. One under this Mac's device id
    /// that isn't waiting here (dismissed, or answered before the hub caught
    /// up) is left out: this Mac's own list is the truth for its sessions.
    static func merge(local sessions: [AgentSession], team: TeamView?, deviceId: String? = nil) -> [NeedItem] {
        var remote = team?.needsMe ?? []
        var out: [NeedItem] = []
        for s in sessions where s.state == "waiting" && s.foldedInto == nil {
            let suffix = ":" + s.key
            let hub = remote.firstIndex { $0.session.hasSuffix(suffix) }.map { remote.remove(at: $0) }
            out.append(NeedItem(local: s, remote: hub, key: s.key, since: s.stateSince ?? s.updatedAt))
        }
        for r in remote where !(deviceId.map { r.session.hasPrefix($0 + ":") } ?? false) {
            let key = r.session.split(separator: ":", maxSplits: 1).last.map(String.init) ?? r.session
            out.append(NeedItem(local: nil, remote: r, key: key, since: r.since ?? 0))
        }
        return out.sorted { $0.since < $1.since }
    }
}
