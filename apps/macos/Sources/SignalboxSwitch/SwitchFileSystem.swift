import Darwin
import Foundation

// Every file operation signalbox-switch makes, in one small protocol, so the verbs can be tested against a temporary
// folder and nothing else in the app writes this way. Never follows a symlink where it writes or reads.

public enum FileKind: Equatable, Sendable {
    case file(size: Int, modified: Date)
    case directory
    case symlink(target: String)
    case other
}

public struct SwitchFileError: Error, CustomStringConvertible, Equatable {
    public var operation: String
    public var path: String
    public var code: Int32

    public init(_ operation: String, _ path: String, code: Int32 = errno) {
        self.operation = operation
        self.path = path
        self.code = code
    }

    public var description: String { "\(operation) \(path): \(String(cString: strerror(code)))" }
}

public protocol SwitchFileSystem: AnyObject {
    /// lstat: nil when nothing is there.
    func kind(_ path: String) -> FileKind?
    func list(_ path: String) throws -> [String]
    /// Creates `path` and any missing parents with `mode`; returns the folders it created, outermost first.
    func ensureDirectory(_ path: String, mode: mode_t) throws -> [String]
    /// A new file in the same folder, created with `mode`, then renamed over `path`.
    func writeAtomically(_ data: Data, to path: String, mode: mode_t) throws
    func append(_ data: Data, to path: String, mode: mode_t) throws
    /// renamex_np with RENAME_EXCL: fails rather than replace anything at `to`.
    func renameExclusive(_ from: String, _ to: String) throws
    /// A plain rename, only for Signalbox's own files (log rotation).
    func rename(_ from: String, _ to: String) throws
    func removeDirectory(_ path: String) throws
    /// Removes a regular file, never a folder.
    func removeFile(_ path: String) throws
    func makeSymlink(at path: String, target: String) throws
    func realpath(_ path: String) -> String?
    /// The device of what `path` names (following links), for "same volume".
    func device(_ path: String) -> UInt64?
    /// Whether the volume holding `path` supports exclusive renames (VOL_CAP_INT_RENAME_EXCL).
    func supportsExclusiveRename(_ path: String) -> Bool
    /// A regular file's bytes (no symlinks), at most `maxBytes`.
    func read(_ path: String, maxBytes: Int) -> Data?
    /// Whether process `pid` exists (kill(pid, 0)).
    func processExists(_ pid: Int32) -> Bool
    /// Whether the volume holding `path` tells names apart by case; nil when it can't be asked.
    func caseSensitive(_ path: String) -> Bool?
}

public final class PosixFileSystem: SwitchFileSystem {
    public init() {}

    public func kind(_ path: String) -> FileKind? {
        var st = stat()
        guard lstat(path, &st) == 0 else { return nil }
        switch st.st_mode & S_IFMT {
        case S_IFREG:
            return .file(size: Int(st.st_size), modified: Date(timeIntervalSince1970: TimeInterval(st.st_mtimespec.tv_sec)))
        case S_IFDIR:
            return .directory
        case S_IFLNK:
            return .symlink(target: (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) ?? "")
        default:
            return .other
        }
    }

    public func list(_ path: String) throws -> [String] {
        guard case .directory? = kind(path) else { throw SwitchFileError("list", path, code: ENOTDIR) }
        return try FileManager.default.contentsOfDirectory(atPath: path).sorted()
    }

    public func ensureDirectory(_ path: String, mode: mode_t) throws -> [String] {
        switch kind(path) {
        case .directory?: return []
        case nil: break
        default: throw SwitchFileError("mkdir", path, code: EEXIST)
        }
        let parent = (path as NSString).deletingLastPathComponent
        var made = parent == path || parent.isEmpty ? [] : try ensureDirectory(parent, mode: mode)
        guard mkdir(path, mode) == 0 else {
            if errno == EEXIST, case .directory? = kind(path) { return made }
            throw SwitchFileError("mkdir", path)
        }
        // The umask may have narrowed the mode, never widened it; make it exact.
        chmod(path, mode)
        made.append(path)
        return made
    }

    public func writeAtomically(_ data: Data, to path: String, mode: mode_t) throws {
        let dir = (path as NSString).deletingLastPathComponent
        let tmp = "\(dir)/.\((path as NSString).lastPathComponent).\(UUID().uuidString).tmp"
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
        guard fd >= 0 else { throw SwitchFileError("create", tmp) }
        var ok = fchmod(fd, mode) == 0
        if ok { ok = writeAll(fd, data) && fsync(fd) == 0 }
        let code = errno
        close(fd)
        guard ok else {
            unlink(tmp)
            throw SwitchFileError("write", tmp, code: code)
        }
        guard Darwin.rename(tmp, path) == 0 else {
            let code = errno
            unlink(tmp)
            throw SwitchFileError("rename", path, code: code)
        }
    }

    public func append(_ data: Data, to path: String, mode: mode_t) throws {
        let fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode)
        guard fd >= 0 else { throw SwitchFileError("open", path) }
        defer { close(fd) }
        guard writeAll(fd, data) else { throw SwitchFileError("append", path) }
    }

    public func renameExclusive(_ from: String, _ to: String) throws {
        guard renamex_np(from, to, UInt32(RENAME_EXCL)) == 0 else { throw SwitchFileError("rename", "\(from) → \(to)") }
    }

    public func rename(_ from: String, _ to: String) throws {
        guard Darwin.rename(from, to) == 0 else { throw SwitchFileError("rename", "\(from) → \(to)") }
    }

    public func removeDirectory(_ path: String) throws {
        guard rmdir(path) == 0 else { throw SwitchFileError("rmdir", path) }
    }

    public func removeFile(_ path: String) throws {
        guard case .file? = kind(path) else { throw SwitchFileError("unlink", path, code: EPERM) }
        guard unlink(path) == 0 else { throw SwitchFileError("unlink", path) }
    }

    public func makeSymlink(at path: String, target: String) throws {
        guard symlink(target, path) == 0 else { throw SwitchFileError("symlink", path) }
    }

    public func realpath(_ path: String) -> String? {
        guard let p = Darwin.realpath(path, nil) else { return nil }
        defer { free(p) }
        return String(cString: p)
    }

    public func device(_ path: String) -> UInt64? {
        var st = stat()
        guard stat(path, &st) == 0 else { return nil }
        return UInt64(bitPattern: Int64(st.st_dev))
    }

    public func supportsExclusiveRename(_ path: String) -> Bool {
        var fs = statfs()
        guard statfs(path, &fs) == 0 else { return false }
        let mount = withUnsafeBytes(of: fs.f_mntonname) { raw in
            String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
        }
        var request = attrlist()
        request.bitmapcount = u_short(ATTR_BIT_MAP_COUNT)
        request.volattr = attrgroup_t(ATTR_VOL_INFO) | attrgroup_t(ATTR_VOL_CAPABILITIES)
        struct Reply {
            var length: UInt32 = 0
            var caps = vol_capabilities_attr_t()
        }
        var reply = Reply()
        guard getattrlist(mount, &request, &reply, MemoryLayout<Reply>.size, 0) == 0 else { return false }
        let index = Int(VOL_CAPABILITIES_INTERFACES)
        let caps = withUnsafeBytes(of: reply.caps.capabilities) { Array($0.bindMemory(to: UInt32.self)) }
        let valid = withUnsafeBytes(of: reply.caps.valid) { Array($0.bindMemory(to: UInt32.self)) }
        let bit = UInt32(VOL_CAP_INT_RENAME_EXCL)
        return valid[index] & bit != 0 && caps[index] & bit != 0
    }

    public func read(_ path: String, maxBytes: Int) -> Data? {
        guard case let .file(size, _)? = kind(path), size <= maxBytes else { return nil }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while out.count <= maxBytes {
            let n = Darwin.read(fd, &buf, buf.count)
            if n < 0 { return nil }
            if n == 0 { break }
            out.append(buf, count: n)
        }
        return out.count <= maxBytes ? out : nil
    }

    public func caseSensitive(_ path: String) -> Bool? {
        let v = pathconf(path, _PC_CASE_SENSITIVE)
        return v < 0 ? nil : v != 0
    }

    public func processExists(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            guard var p = raw.baseAddress else { return true }
            var left = raw.count
            while left > 0 {
                let n = write(fd, p, left)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                left -= n
                p = p.advanced(by: n)
            }
            return true
        }
    }
}
