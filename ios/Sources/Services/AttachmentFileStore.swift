import Foundation
import UniformTypeIdentifiers

struct AttachmentFileStore: Sendable {
    func savePhotoData(_ data: Data, suggestedExtension: String = "jpg") throws -> ChatAttachment {
        let directory = try attachmentDirectory()
        let fileName = "photo-\(UUID().uuidString).\(suggestedExtension)"
        let destination = directory.appendingPathComponent(fileName)
        try data.write(to: destination, options: .atomic)
        return ChatAttachment(
            kind: .image,
            displayName: fileName,
            localURL: destination,
            byteCount: Int64(data.count)
        )
    }

    func importFiles(_ urls: [URL]) throws -> [ChatAttachment] {
        var imported: [ChatAttachment] = []
        do {
            for url in urls {
                imported.append(try importFile(url))
            }
            return imported
        } catch {
            for attachment in imported {
                try? FileManager.default.removeItem(at: attachment.localURL)
            }
            throw error
        }
    }

    private func importFile(_ source: URL) throws -> ChatAttachment {
        let didAccess = source.startAccessingSecurityScopedResource()
        defer {
            if didAccess { source.stopAccessingSecurityScopedResource() }
        }

        let directory = try attachmentDirectory()
        let destination = uniqueDestination(for: source.lastPathComponent, in: directory)
        try FileManager.default.copyItem(at: source, to: destination)

        let values = try? destination.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        let type = values?.contentType
        let kind: ChatAttachment.Kind = type?.conforms(to: .image) == true ? .image : .file

        return ChatAttachment(
            kind: kind,
            displayName: source.lastPathComponent,
            localURL: destination,
            byteCount: values?.fileSize.map { Int64($0) }
        )
    }

    private func attachmentDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("RubatoChatAttachments", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func uniqueDestination(for fileName: String, in directory: URL) -> URL {
        let proposed = directory.appendingPathComponent(fileName)
        guard FileManager.default.fileExists(atPath: proposed.path) else { return proposed }

        let base = proposed.deletingPathExtension().lastPathComponent
        let ext = proposed.pathExtension
        let suffix = UUID().uuidString.prefix(8)
        return directory.appendingPathComponent("\(base)-\(suffix)").appendingPathExtension(ext)
    }
}
