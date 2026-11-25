import Foundation

enum DaemonError: Error {
    case noSecret
    case notRunning
    case http(Int)
    case badResponse
}

/// Thin HTTP client for the daemon's loopback API. All state lives in the
/// daemon; this only reads it and issues control calls.
struct DaemonClient {
    /// The daemon secret is read fresh each call so a daemon restart (new
    /// secret) is picked up without restarting the app.
    private func secret() throws -> String {
        guard let data = FileManager.default.contents(atPath: Paths.daemonSecretPath),
              let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty
        else { throw DaemonError.noSecret }
        return s
    }

    /// Port comes from config.json (default 4519) so a custom `port` still works.
    private var port: Int {
        guard let data = FileManager.default.contents(atPath: Paths.configPath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let p = obj["port"] as? Int
        else { return 4519 }
        return p
    }

    private func request(_ method: String, _ path: String, body: Data? = nil, timeout: TimeInterval = 3) async throws -> Data {
        let token = try secret()
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = timeout
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw DaemonError.notRunning // connection refused → daemon down
        }
        guard let http = resp as? HTTPURLResponse else { throw DaemonError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw DaemonError.http(http.statusCode) }
        return data
    }

    func fetchState() async throws -> DaemonState {
        let data = try await request("GET", "/state")
        return try JSONDecoder().decode(DaemonState.self, from: data)
    }

    func fetchConfig() async throws -> DaemonConfig {
        let data = try await request("GET", "/config")
        return try JSONDecoder().decode(DaemonConfig.self, from: data)
    }

    /// The team view the daemon caches from the hub. `open` while the menu is
    /// showing, so the daemon reads the hub more often. nil for a daemon that
    /// predates the endpoint (404): the menu then hides the team UI.
    func fetchTeam(open: Bool) async throws -> TeamState? {
        do {
            let data = try await request("GET", open ? "/team?open=1" : "/team")
            return try JSONDecoder().decode(TeamState.self, from: data)
        } catch DaemonError.http(404) {
            return nil
        }
    }

    /// What the daemon knows about a newer Workmesh and how to install it here.
    /// nil for a daemon without the endpoint (404): the menu shows nothing.
    func fetchUpdate() async throws -> UpdateInfo? {
        do {
            let data = try await request("GET", "/update")
            return try JSONDecoder().decode(UpdateInfo.self, from: data)
        } catch DaemonError.http(404) {
            return nil
        }
    }

    @discardableResult
    func pause() async throws -> Data { try await request("POST", "/pause") }

    /// Snooze: the daemon resumes Slack sync on its own when the preset ends.
    @discardableResult
    func snooze(_ preset: SnoozePreset) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: ["for": preset.rawValue])
        return try await request("POST", "/pause", body: body)
    }

    /// Drops a session from the daemon's list until it reports again.
    @discardableResult
    func dismiss(key: String) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: ["key": key])
        return try await request("POST", "/sessions/dismiss", body: body)
    }

    @discardableResult
    func resume() async throws -> Data { try await request("POST", "/resume") }

    /// v2: a coordination call as the person, not an agent (POST /coord/op):
    /// accept or decline a handoff, approve or deny an approval. The daemon
    /// makes the hub call (up to 8 s), so this waits longer than the reads.
    func coordOp(_ op: String, args: [String: Any]) async throws -> CoordOpAnswer {
        let body = try JSONSerialization.data(withJSONObject: ["op": op, "args": args, "caller": ["client": "menubar"]])
        let data = try await request("POST", "/coord/op", body: body, timeout: 12)
        return try JSONDecoder().decode(CoordOpAnswer.self, from: data)
    }

    @discardableResult
    func patchConfig(_ patch: [String: Any]) async throws -> DaemonConfig {
        let body = try JSONSerialization.data(withJSONObject: patch)
        let data = try await request("POST", "/config", body: body)
        return try JSONDecoder().decode(DaemonConfig.self, from: data)
    }
}
