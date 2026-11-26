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
    /// v2: handoffs offered to me or running here, and pending approvals (absent from older daemons).
    let delegate: DelegateState?
    /// Machines that joined my account in the last day and weren't dismissed (none from older daemons).
    let newDevices: [NewDeviceNotice]

    private enum K: String, CodingKey {
        case enabled, hubUrl, boardUrl, hubName, deviceId, share, connected, halted, available, fetchedAt, error, pollMs, team, coord, delegate, newDevices
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
        delegate = c.lenient(DelegateState.self, .delegate)
        newDevices = c.lossy(NewDeviceNotice.self, .newDevices)
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
// reached yet). `held` is teammates' messages that wait for me instead: their
// session runs with no permission prompts, so the agent gets one only if I
// deliver it (absent from older daemons). Read leniently, like the rest of
// /team.

struct CoordState: Decodable {
    /// nil = not synced yet; false = the hub has no coordination.
    let available: Bool?
    let holds: [CoordHold]
    let unread: [CoordMessage]
    let held: [CoordHeld]

    private enum K: String, CodingKey { case available, holds, unread, held }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        available = c.lenient(Bool.self, .available)
        holds = c.lossy(CoordHold.self, .holds)
        unread = c.lossy(CoordMessage.self, .unread)
        held = c.lossy(CoordHeld.self, .held)
    }

    init(available: Bool?, holds: [CoordHold], unread: [CoordMessage], held: [CoordHeld] = []) {
        self.available = available
        self.holds = holds
        self.unread = unread
        self.held = held
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
    /// Where the hub made it from, when no paired machine sent it: "linear" (a Linear prompt) or "other".
    let via: String?
    let text: String
    let ts: Double?

    private enum K: String, CodingKey { case id, session, name, from, fromSession, via, text, ts }

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
        via = c.text(.via)
        ts = c.lenient(Double.self, .ts)
    }
}

/// " via Linear" after a sender's name, when the hub made the message from a
/// source other than a paired machine. Empty for every other message.
func viaNote(_ via: String?) -> String {
    switch via {
    case nil: return ""
    case "linear": return " via Linear"
    default: return " via another source"
    }
}

/// A teammate's message held for me (the daemon cleaned its names and text).
struct CoordHeld: Decodable, Identifiable {
    let id: String
    /// The session it is for (local key), and its name.
    let session: String?
    let name: String?
    let from: String
    let fromSession: String?
    /// Where the hub made it from, when no paired machine sent it: "linear" (a Linear prompt) or "other".
    let via: String?
    let text: String
    /// When it was held and when it is dropped if I do nothing, on this Mac's clock (epoch ms).
    let since: Double?
    let dropAt: Double?

    /// "Dropped in 42 min if you do nothing", from the daemon's drop time.
    func fate(now: Date) -> String? {
        guard let dropAt else { return nil }
        let mins = Int(((dropAt / 1000 - now.timeIntervalSince1970) / 60).rounded(.up))
        if mins <= 0 { return "About to be dropped" }
        return mins < 120 ? "Dropped in \(mins) min if you do nothing" : "Dropped in \(mins / 60) h if you do nothing"
    }

    private enum K: String, CodingKey { case id, session, name, from, fromSession, via, text, since, dropAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let id = c.text(.id), let text = c.text(.text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "held message without id or text"))
        }
        self.id = id
        self.text = text
        session = c.text(.session)
        name = c.text(.name)
        from = c.text(.from) ?? "A teammate"
        fromSession = c.text(.fromSession)
        via = c.text(.via)
        since = c.lenient(Double.self, .since)
        dropAt = c.lenient(Double.self, .dropAt)
    }
}

// MARK: - New machines on my account (inside GET /team)
//
// The hub names machines added to a person's account, and the daemon lists
// each one for a day or until it is dismissed (POST /new-devices/dismiss). The
// app posts one notification per machine and shows a row. Read leniently like
// the rest of /team: an item without an id is dropped.

struct NewDeviceNotice: Decodable, Identifiable {
    let id: String
    /// The machine's name, already on one line.
    let machine: String
    /// Where it joined from, when the hub said (`where` on the wire).
    let place: String?
    /// When it was added (epoch ms, hub clock); nil when the hub didn't say.
    let pairedAt: Double?
    /// The whole notice, as `workmesh status` prints it.
    let text: String?

    /// "Joined your account from Lisbon, Portugal (Example Telecom)".
    var joined: String { "Joined your account" + (place.map { " from \($0)" } ?? "") }

    private enum K: String, CodingKey {
        case id, machine, pairedAt, text
        case place = "where"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let id = c.text(.id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "new machine without an id"))
        }
        self.id = id
        machine = c.text(.machine) ?? "An unnamed machine"
        place = c.text(.place)
        let at = c.lenient(Double.self, .pairedAt) ?? 0
        pairedAt = at > 0 ? at : nil
        text = c.text(.text)
    }
}

// MARK: - Delegate (v2, inside GET /team)
//
// Handoffs offered to this person (Accept / Decline) or running on this Mac,
// and pending approvals: this Mac's agents' asks, and ones this person may
// decide. Read leniently like the rest of /team: an item without an id is
// dropped, and a status the app doesn't know is neither offered nor pending.

struct DelegateState: Decodable {
    /// The hub serves v2.
    let available: Bool?
    let handoffs: [DelegateHandoff]
    let approvals: [DelegateApproval]

    private enum K: String, CodingKey { case available, handoffs, approvals }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        available = c.lenient(Bool.self, .available)
        handoffs = c.lossy(DelegateHandoff.self, .handoffs)
        approvals = c.lossy(DelegateApproval.self, .approvals)
    }

    /// Offered to me (oldest first), then the ones accepted somewhere else
    /// that wait for "Run here", then the ones running on this Mac.
    var shownHandoffs: [DelegateHandoff] {
        let offered = handoffs.filter(\.isOffered).sorted { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }
        return offered + handoffs.filter(\.waitsToRun) + handoffs.filter(\.runningHere)
    }

    /// Pending ones I may decide or this Mac's agents asked, oldest first.
    var shownApprovals: [DelegateApproval] {
        approvals.filter { $0.isPending && ($0.canDecide || $0.mine) }.sorted { ($0.ts ?? 0) < ($1.ts ?? 0) }
    }
}

struct DelegateHandoff: Decodable, Identifiable {
    let id: String
    let from: String
    let fromSession: String?
    /// The whole task, as the daemon cleaned it for reading (an older daemon
    /// sends its first 500 characters).
    let task: String
    /// More from the sender: links, decisions, where to start (absent: none,
    /// or an older daemon).
    let context: String?
    /// What Accept (or "Run here") starts on this Mac, in the daemon's words
    /// (absent from an older daemon).
    let onAccept: HandoffStart?
    /// Set for a handoff that was accepted somewhere else, such as on the
    /// board: the daemon's question ("Accepted on the board: run it here?").
    /// This Mac starts it only after the person's "Run here".
    let runHere: String?
    let repo: String?
    let issue: String?
    /// offered | accepted | started | done | failed | declined (kept as sent).
    let status: String?
    let createdAt: Double?
    let runningHere: Bool

    /// Waiting for my Accept or Decline.
    var isOffered: Bool { status == "offered" && !runningHere }

    /// Accepted somewhere else, and waiting for my "Run here" on this Mac.
    var waitsToRun: Bool { status == "accepted" && !runningHere && runHere != nil }

    /// "from An · b3-fun/b3os-beta · B3-7168".
    var origin: String { ["from \(from)", repo, issue].compactMap { $0 }.joined(separator: " · ") }

    /// A task this short, on one line, is shown whole in its row.
    static let rowTaskMax = 80

    /// The row can't show all of the handoff: it has a context, or a task
    /// that is long or has more than one line. Such a row shows two lines and
    /// offers "Show all", and Accept opens the whole text before it accepts.
    var hidesText: Bool {
        context != nil || task.count > Self.rowTaskMax || task.contains(where: \.isNewline)
    }

    private enum K: String, CodingKey { case id, from, fromSession, task, context, onAccept, runHere, repo, issue, status, createdAt, runningHere }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let id = c.text(.id), let task = c.text(.task) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "handoff without id or task"))
        }
        self.id = id
        self.task = task
        context = c.text(.context)
        onAccept = c.lenient(HandoffStart.self, .onAccept)
        runHere = c.text(.runHere)
        from = c.text(.from) ?? "A teammate"
        fromSession = c.text(.fromSession)
        repo = c.text(.repo)
        issue = c.text(.issue)
        status = c.text(.status)
        createdAt = c.lenient(Double.self, .createdAt)
        runningHere = c.lenient(Bool.self, .runningHere) ?? false
    }
}

/// What accepting a handoff starts on this Mac. The daemon writes the line;
/// the app only shows it.
struct HandoffStart: Decodable {
    /// claude | codex (kept as sent); nil when this Mac can't run the handoff.
    let agent: String?
    /// "Starts a Claude Code agent on this Mac in auto mode, in a new worktree of b3-fun/b3os-beta."
    let text: String

    private enum K: String, CodingKey { case agent, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let text = c.text(.text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "start line without text"))
        }
        self.text = text
        agent = c.text(.agent)
    }
}

struct DelegateApproval: Decodable, Identifiable {
    let id: String
    /// This Mac's session that asked, and its name.
    let session: String?
    let name: String?
    /// merge | deploy | publish | force_push | spend | custom (kept as sent).
    let gate: String?
    let detail: String
    let status: String?
    let ts: Double?
    /// One of this Mac's agents asked.
    let mine: Bool
    /// This person may approve or deny it.
    let canDecide: Bool

    /// The daemon lists pending ones only; a status it adds later isn't pending.
    var isPending: Bool { status == nil || status == "pending" }

    /// "your agent documents-07 asks to merge", or the gate for a teammate's ask.
    var ask: String {
        guard mine else { return gateLabel }
        return "your agent" + (name.map { " \($0)" } ?? "") + " asks to \(verb)"
    }

    private var verb: String {
        switch gate {
        case let g? where ["merge", "deploy", "publish", "spend"].contains(g): return g
        case "force_push": return "force-push"
        default: return "run" // custom, or a gate this app doesn't know
        }
    }

    private var gateLabel: String {
        guard let gate else { return "approval" }
        return gate.replacingOccurrences(of: "_", with: "-")
    }

    private enum K: String, CodingKey { case id, session, name, gate, detail, status, ts, mine, canDecide }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        guard let id = c.text(.id), let detail = c.text(.detail) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "approval without id or detail"))
        }
        self.id = id
        self.detail = detail
        session = c.text(.session)
        name = c.text(.name)
        gate = c.text(.gate)
        status = c.text(.status)
        ts = c.lenient(Double.self, .ts)
        mine = c.lenient(Bool.self, .mine) ?? false
        canDecide = c.lenient(Bool.self, .canDecide) ?? false
    }
}

/// POST /coord/op's answer: `{ok, text, data}` (data unused here).
struct CoordOpAnswer: Decodable {
    let ok: Bool
    let text: String?

    private enum K: String, CodingKey { case ok, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        text = c.text(.text)
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

// MARK: - Update (GET /update)
//
// The daemon knows its own version, the newest release, how this install can
// be updated and the release's menu bar zip. The app only reads it; the one
// decision it makes itself is whether that zip is newer than the app it is.
// Read leniently, like /team; a daemon without the endpoint (404) shows nothing.

struct UpdateInfo: Decodable {
    let current: String?
    let latest: String?
    let available: Bool
    let checkedAt: Double?
    let source: String?
    let install: Install
    /// argv that runs the update; present when `install.canUpdate`.
    let run: [String]
    let auto: Auto?
    let last: Last?
    let menubar: MenubarRelease?

    struct Install: Decodable {
        let method: String?
        let canUpdate: Bool
        /// When it can't: one sentence, may hold a `command` in backticks.
        let hint: String?

        private enum K: String, CodingKey { case method, canUpdate, hint }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            method = c.text(.method)
            canUpdate = c.lenient(Bool.self, .canUpdate) ?? false
            hint = c.text(.hint)
        }

        init(method: String?, canUpdate: Bool, hint: String?) {
            self.method = method
            self.canUpdate = canUpdate
            self.hint = hint
        }
    }

    struct Auto: Decodable {
        let enabled: Bool
        let scope: String?

        private enum K: String, CodingKey { case enabled, scope }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            enabled = c.lenient(Bool.self, .enabled) ?? false
            scope = c.text(.scope)
        }
    }

    struct Last: Decodable {
        let at: Double?
        let ok: Bool
        let from: String?
        let to: String?
        let rolledBack: Bool
        let message: String?

        private enum K: String, CodingKey { case at, ok, from, to, rolledBack, message }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            at = c.lenient(Double.self, .at)
            ok = c.lenient(Bool.self, .ok) ?? false
            from = c.text(.from)
            to = c.text(.to)
            rolledBack = c.lenient(Bool.self, .rolledBack) ?? false
            message = c.text(.message)
        }
    }

    /// The release's menu bar zip, as the daemon read and checked it. The
    /// daemon sends it only once it may be offered: old enough, and, when
    /// release signing is on, named in a list a maintainer key signed.
    struct MenubarRelease: Decodable, Equatable {
        let version: String
        let url: URL
        /// 64 lowercase hex: the zip's SHA-256. From the release's signed
        /// list when `signed`, else the digest GitHub lists for the asset.
        let sha256: String
        let size: Int?
        let releaseUrl: String?
        /// A pinned maintainer key signed the list this hash came from.
        let signed: Bool

        private enum K: String, CodingKey { case version, url, sha256, size, releaseUrl, signed }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            guard let version = c.text(.version), let s = c.text(.url), let url = URL(string: s),
                  let sha = c.text(.sha256)
            else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "incomplete menubar release")) }
            self.version = version
            self.url = url
            sha256 = sha.lowercased()
            size = c.lenient(Int.self, .size)
            releaseUrl = c.text(.releaseUrl)
            signed = c.lenient(Bool.self, .signed) ?? false
        }

        init(version: String, url: URL, sha256: String, size: Int?, releaseUrl: String?, signed: Bool = false) {
            self.version = version
            self.url = url
            self.sha256 = sha256
            self.size = size
            self.releaseUrl = releaseUrl
            self.signed = signed
        }
    }

    private enum K: String, CodingKey { case current, latest, available, checkedAt, source, install, run, auto, last, menubar }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        current = c.text(.current)
        latest = c.text(.latest)
        available = c.lenient(Bool.self, .available) ?? false
        checkedAt = c.lenient(Double.self, .checkedAt)
        source = c.text(.source)
        install = c.lenient(Install.self, .install) ?? Install(method: nil, canUpdate: false, hint: nil)
        run = (c.lenient([String].self, .run) ?? []).filter { !$0.isEmpty }
        auto = c.lenient(Auto.self, .auto)
        last = c.lenient(Last.self, .last)
        menubar = c.lenient(MenubarRelease.self, .menubar)
    }

    /// `workmesh update` can run here: the daemon says so and gave an absolute program.
    var canRun: Bool { install.canUpdate && run.first?.hasPrefix("/") == true }

    /// The hint's first `command` in backticks, for a copy button.
    var hintCommand: String? {
        guard let hint = install.hint else { return nil }
        let parts = hint.components(separatedBy: "`")
        guard parts.count >= 3 else { return nil }
        let cmd = parts[1].trimmingCharacters(in: .whitespaces)
        return cmd.isEmpty ? nil : cmd
    }
}

/// Release versions as the daemon and the bundle write them: "0.12.1",
/// "v0.12.1", "0.13.0-beta.2". Numeric parts compare as numbers; a pre-release
/// sorts below its release. Anything else isn't newer than anything.
enum ReleaseVersion {
    static func isNewer(_ a: String, than b: String) -> Bool {
        guard let x = parse(a), let y = parse(b) else { return false }
        for i in 0..<max(x.core.count, y.core.count) {
            let p = i < x.core.count ? x.core[i] : 0
            let q = i < y.core.count ? y.core[i] : 0
            if p != q { return p > q }
        }
        switch (x.pre, y.pre) {
        case (nil, nil): return false
        case (nil, _): return true // 1.0.0 > 1.0.0-beta
        case (_, nil): return false
        case (let p?, let q?): return p.compare(q, options: .numeric) == .orderedDescending
        }
    }

    private static func parse(_ s: String) -> (core: [Int], pre: String?)? {
        var v = s.trimmingCharacters(in: .whitespaces)
        if v.hasPrefix("v") { v.removeFirst() }
        let main = v.split(separator: "+", maxSplits: 1).first.map(String.init) ?? v
        let parts = main.split(separator: "-", maxSplits: 1).map(String.init)
        guard let corePart = parts.first else { return nil }
        let core = corePart.split(separator: ".").map { Int($0) }
        guard !core.isEmpty, core.count <= 4, core.allSatisfy({ $0 != nil }) else { return nil }
        return (core.compactMap { $0 }, parts.count > 1 ? parts[1] : nil)
    }
}

/// The menu's update item: what there is to do, read off GET /update and the runner.
enum UpdateOffer {
    /// An update is running (the window may be closed): reopen it.
    case inProgress
    /// A newer Workmesh that `workmesh update` can install here.
    case workmesh(UpdateInfo)
    /// A newer Workmesh this install can't take by itself: the daemon's hint.
    case hint(UpdateInfo)
    /// Only this menu bar app is behind the release.
    case app(UpdateInfo.MenubarRelease, have: String)
}
