# Bloom Audio Compressor

A small Windows app that makes the recorded audio in a [Bloom](https://bloomlibrary.org)
collection smaller.

1. Choose a collection. Every book that has recorded audio is listed with its current size.
2. Pick a quality (Speech 24 kbps, Balanced 48 kbps, High quality 96 kbps, or a custom
   bitrate) and tick the books to compress.
3. Expand a book and click **Preview** on any clip to hear it at that setting first.
4. Compress. The originals are kept outside the collection, in
   `%LOCALAPPDATA%\BloomAudioCompressor\backups`, so they are never published, uploaded,
   or checked in to a Team Collection with the book. Compressing a book again, at another
   setting, starts from those originals.
5. Changed your mind, even days later? **Restore original audio…** at the bottom of the
   settings puts the original recordings back. A clip recorded again since is left alone.

The app uses the ffmpeg that comes with Bloom, so Bloom must be installed.

## Download

The latest installer is on the
[Releases page](https://github.com/BloomBooks/compress-bloom-audio/releases/latest).
Installed copies update themselves from there.

## Development

See [CLAUDE.md](CLAUDE.md) for the toolchain and commands, [RELEASING.md](RELEASING.md)
for releases, and [packages/app/README.md](packages/app/README.md) for how the desktop
shell works.

## License

MIT © SIL Global. See [LICENSE](LICENSE).
