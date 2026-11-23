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
