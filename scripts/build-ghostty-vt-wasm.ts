#!/usr/bin/env bun

/** Build the upstream C ABI as a browser-loadable WASM module, without ghostty-web's fork. */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { GHOSTTY_REVISION, GHOSTTY_WEB_ARTIFACT_ID, withGhosttySource } from './ghostty-source'

const OUTPUT_DIR = resolve(import.meta.dir, '../apps/desktop/public')

// Upstream disables Kitty graphics on freestanding targets because file/shared-memory media
// and a host PNG decoder are unavailable. A browser needs neither: disable file I/O entirely,
// keep only direct transmit, and decode PNG with upstream's already-vendored Wuffs. Apply this
// narrowly to the checksum-verified source and fail closed if upstream changes these seams.
function enableBrowserGraphics(source: string): void {
  const options = join(source, 'src/terminal/build_options.zig')
  const image = join(source, 'src/terminal/kitty/graphics_image.zig')
  const replace = (path: string, oldText: string, newText: string) => {
    const text = readFileSync(path, 'utf8')
    if (text.split(oldText).length !== 2)
      throw new Error(`Ghostty patch no longer applies: ${path}`)
    writeFileSync(path, text.replace(oldText, newText))
  }
  replace(options, 'if (target.os.tag == .freestanding) return false;', '_ = target;')
  replace(
    image,
    `        switch (medium) {
            .file, .temporary_file => {},
            else => @compileError("readFile only supports file and temporary_file"),
        }`,
    `        if (comptime builtin.os.tag == .freestanding) {
            // Browser embeds cannot access the host filesystem.
            _ = .{ self, io, alloc, t, path };
            return error.InvalidData;
        } else {
        switch (medium) {
            .file, .temporary_file => {},
            else => @compileError("readFile only supports file and temporary_file"),
        }`,
  )
  replace(
    image,
    `        self.data = .{ .items = managed.items, .capacity = managed.capacity };
    }

    /// Returns the canonical path`,
    `        self.data = .{ .items = managed.items, .capacity = managed.capacity };
        }
    }

    /// Returns the canonical path`,
  )
  replace(
    image,
    `        const decode_png_fn = sys.decode_png orelse
            return error.UnsupportedFormat;

        var limited: LimitedAllocator = .init(alloc, max_size);
        const decode_alloc = limited.allocator();
        const result = decode_png_fn(
            decode_alloc,
            self.data.items,
        ) catch |err| switch (err) {
            error.InvalidData => return error.InvalidData,
            error.OutOfMemory => if (limited.limit_exceeded)
                return error.InvalidData
            else
                return error.OutOfMemory,
        };`,
    `        var limited: LimitedAllocator = .init(alloc, max_size);
        const decode_alloc = limited.allocator();
        const result = if (comptime builtin.os.tag == .freestanding)
            @import("wuffs").png.decode(decode_alloc, self.data.items) catch |err| switch (err) {
                error.OutOfMemory => if (limited.limit_exceeded)
                    return error.InvalidData
                else
                    return error.OutOfMemory,
                else => return error.InvalidData,
            }
        else blk: {
            const decode_png_fn = sys.decode_png orelse return error.UnsupportedFormat;
            break :blk decode_png_fn(decode_alloc, self.data.items) catch |err| switch (err) {
                error.InvalidData => return error.InvalidData,
                error.OutOfMemory => if (limited.limit_exceeded)
                    return error.InvalidData
                else
                    return error.OutOfMemory,
            };
        };`,
  )
}

function validateWasm(bytes: Uint8Array): void {
  const module = new WebAssembly.Module(Uint8Array.from(bytes))
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error('Unexpected Ghostty WASM imports')
  }
  const exportedNames = new Set(WebAssembly.Module.exports(module).map(({ name }) => name))
  for (const name of [
    'memory',
    '__indirect_function_table',
    'ghostty_type_json',
    'ghostty_terminal_new',
    'ghostty_terminal_free',
    'ghostty_terminal_vt_write',
    'ghostty_render_state_new',
    'ghostty_render_state_update',
    'ghostty_render_state_get',
    'ghostty_render_state_clean',
    'ghostty_render_state_row_get',
    'ghostty_kitty_graphics_get',
    'ghostty_kitty_graphics_placement_render_info',
    'ghostty_wasm_alloc',
    'ghostty_wasm_alloc_opaque',
    'ghostty_wasm_take_opaque',
  ]) {
    if (!exportedNames.has(name)) throw new Error(`Ghostty WASM is missing ${name}`)
  }

  // Exercise the *actual* upstream ABI. Merely checking export names would accept a module
  // that links but cannot create a terminal or produce a drawable frame.
  type Abi = {
    memory: WebAssembly.Memory
    ghostty_type_json(): number
    ghostty_terminal_new(allocator: number, slot: number, cols: number, rows: number): number
    ghostty_terminal_free(handle: number): void
    ghostty_terminal_vt_write(handle: number, bytes: number, len: number): void
    ghostty_terminal_set(handle: number, option: number, value: number): number
    ghostty_terminal_get(handle: number, data: number, out: number): number
    ghostty_kitty_graphics_image(graphics: number, id: number): number
    ghostty_kitty_graphics_image_get(image: number, data: number, out: number): number
    ghostty_render_state_new(allocator: number, slot: number): number
    ghostty_render_state_free(handle: number): void
    ghostty_render_state_update(state: number, terminal: number): number
    ghostty_render_state_get(state: number, kind: number, out: number): number
    ghostty_render_state_clean(state: number): number
    ghostty_render_state_row_iterator_new(allocator: number, slot: number): number
    ghostty_render_state_row_iterator_free(handle: number): void
    ghostty_render_state_row_iterator_next_dirty(handle: number, out: number): number
    ghostty_render_state_row_get(iterator: number, kind: number, out: number): number
    ghostty_render_state_row_cells_new(allocator: number, slot: number): number
    ghostty_render_state_row_cells_free(handle: number): void
    ghostty_render_state_row_cells_next(handle: number): number
    ghostty_render_state_row_cells_get(handle: number, kind: number, out: number): number
    ghostty_wasm_alloc(len: number): number
    ghostty_wasm_free(ptr: number, len: number): void
    ghostty_wasm_alloc_opaque(): number
    ghostty_wasm_take_opaque(slot: number): number
    ghostty_wasm_free_opaque(slot: number): void
  }
  const abi = new WebAssembly.Instance(module).exports as unknown as Abi
  const manifestPtr = abi.ghostty_type_json()
  const manifestBytes = new Uint8Array(abi.memory.buffer)
  let manifestEnd = manifestPtr
  while (manifestEnd < manifestBytes.length && manifestBytes[manifestEnd] !== 0) manifestEnd++
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestBytes.subarray(manifestPtr, manifestEnd)),
  ) as {
    abi: { pointer_size: number; endian: string }
    commit: string | null
  }
  if (manifest.abi.pointer_size !== 4 || manifest.abi.endian !== 'little') {
    throw new Error('Unsupported Ghostty WASM ABI')
  }
  // GitHub archives have no .git directory, so upstream reports a null commit in that case.
  if (manifest.commit !== null && manifest.commit !== GHOSTTY_REVISION) {
    throw new Error(`Ghostty WASM came from ${manifest.commit}, not ${GHOSTTY_REVISION}`)
  }

  const slot = abi.ghostty_wasm_alloc_opaque()
  if (slot === 0) throw new Error('Cannot allocate Ghostty handle slot')
  let terminal = 0
  let state = 0
  let rows = 0
  let cells = 0
  let scratch = 0
  let data = 0
  let imageInput = 0
  const text = new TextEncoder().encode('Tau VT smoke')
  const imageSequence = new TextEncoder().encode('\x1b_Ga=T,f=32,s=1,v=1,i=1;/wAA/w==\x1b\\')
  try {
    if (abi.ghostty_terminal_new(0, slot, 12, 3) !== 0)
      throw new Error('Cannot open Ghostty terminal')
    terminal = abi.ghostty_wasm_take_opaque(slot)
    if (abi.ghostty_render_state_new(0, slot) !== 0) throw new Error('Cannot open render state')
    state = abi.ghostty_wasm_take_opaque(slot)
    data = abi.ghostty_wasm_alloc(text.length)
    scratch = abi.ghostty_wasm_alloc(64)
    if (!data || !scratch) throw new Error('Cannot allocate Ghostty WASM scratch memory')
    new DataView(abi.memory.buffer).setBigUint64(scratch, 16n * 1024n * 1024n, true)
    if (abi.ghostty_terminal_set(terminal, 15, scratch) !== 0)
      throw new Error('Ghostty Kitty image storage is unavailable')
    new Uint8Array(abi.memory.buffer).set(text, data)
    abi.ghostty_terminal_vt_write(terminal, data, text.length)
    if (abi.ghostty_render_state_update(state, terminal) !== 0) {
      throw new Error('Cannot update Ghostty render state')
    }
    // RenderStateData.DIRTY = 3 (upstream include/ghostty/vt/render.h).
    if (abi.ghostty_render_state_get(state, 3, scratch) !== 0) {
      throw new Error('Cannot read Ghostty dirty state')
    }
    const dirty = new DataView(abi.memory.buffer).getUint32(scratch, true)
    if (dirty === 0 || dirty > 2) throw new Error(`Unexpected Ghostty dirty state: ${dirty}`)

    if (abi.ghostty_render_state_row_iterator_new(0, slot) !== 0) {
      throw new Error('Cannot create Ghostty row iterator')
    }
    rows = abi.ghostty_wasm_take_opaque(slot)
    if (abi.ghostty_render_state_row_cells_new(0, slot) !== 0) {
      throw new Error('Cannot create Ghostty cell iterator')
    }
    cells = abi.ghostty_wasm_take_opaque(slot)
    // The row/cell getters fill pre-existing handles passed by pointer.
    new DataView(abi.memory.buffer).setUint32(slot, rows, true)
    if (abi.ghostty_render_state_get(state, 4, slot) !== 0) {
      throw new Error('Cannot read Ghostty rows')
    }
    if (!abi.ghostty_render_state_row_iterator_next_dirty(rows, scratch)) {
      throw new Error('Ghostty did not mark the written row dirty')
    }
    if (new DataView(abi.memory.buffer).getUint16(scratch, true) !== 0) {
      throw new Error('Ghostty returned an unexpected first row')
    }
    new DataView(abi.memory.buffer).setUint32(slot, cells, true)
    if (abi.ghostty_render_state_row_get(rows, 3, slot) !== 0) {
      throw new Error('Cannot read Ghostty cells')
    }
    let rendered = ''
    while (abi.ghostty_render_state_row_cells_next(cells)) {
      if (abi.ghostty_render_state_row_cells_get(cells, 3, scratch) !== 0) {
        throw new Error('Cannot read Ghostty grapheme length')
      }
      const length = new DataView(abi.memory.buffer).getUint32(scratch, true)
      if (length === 0) {
        rendered += ' '
      } else {
        if (length > 16 || abi.ghostty_render_state_row_cells_get(cells, 4, scratch) !== 0) {
          throw new Error('Cannot read Ghostty grapheme')
        }
        for (let i = 0; i < length; i++) {
          rendered += String.fromCodePoint(
            new DataView(abi.memory.buffer).getUint32(scratch + i * 4, true),
          )
        }
      }
    }
    if (rendered !== 'Tau VT smoke') throw new Error(`Unexpected Ghostty frame: ${rendered}`)
    if (abi.ghostty_render_state_clean(state) !== 0) {
      throw new Error('Cannot clean Ghostty render state')
    }
    // This catches the ReleaseSmall wasm32 miscompile that links but traps on Kitty transmit.
    imageInput = abi.ghostty_wasm_alloc(imageSequence.length)
    if (!imageInput) throw new Error('Cannot allocate Ghostty image input')
    new Uint8Array(abi.memory.buffer).set(imageSequence, imageInput)
    abi.ghostty_terminal_vt_write(terminal, imageInput, imageSequence.length)
    if (abi.ghostty_terminal_get(terminal, 30, scratch) !== 0)
      throw new Error('Cannot query Ghostty image storage')
    const graphics = new DataView(abi.memory.buffer).getUint32(scratch, true)
    const image = abi.ghostty_kitty_graphics_image(graphics, 1)
    if (!image || abi.ghostty_kitty_graphics_image_get(image, 7, scratch) !== 0)
      throw new Error('Ghostty did not decode a Kitty image')
    const pixel = new DataView(abi.memory.buffer).getUint32(scratch, true)
    const rgba = new Uint8Array(abi.memory.buffer, pixel, 4)
    if (rgba.some((value, i) => value !== [255, 0, 0, 255][i]))
      throw new Error('Ghostty decoded incorrect Kitty pixels')
  } finally {
    if (imageInput) abi.ghostty_wasm_free(imageInput, imageSequence.length)
    if (data) abi.ghostty_wasm_free(data, text.length)
    if (scratch) abi.ghostty_wasm_free(scratch, 64)
    if (cells) abi.ghostty_render_state_row_cells_free(cells)
    if (rows) abi.ghostty_render_state_row_iterator_free(rows)
    if (state) abi.ghostty_render_state_free(state)
    if (terminal) abi.ghostty_terminal_free(terminal)
    abi.ghostty_wasm_free_opaque(slot)
  }
}

withGhosttySource((source) => {
  enableBrowserGraphics(source)
  execFileSync(
    'zig',
    // ReleaseSmall currently miscompiles Ghostty Kitty graphics on wasm32 (OOB on transmit).
    // ReleaseSafe preserves bounds checks and passes the image-transmission smoke test.
    ['build', '-Demit-lib-vt=true', '-Dtarget=wasm32-freestanding', '-Doptimize=ReleaseSafe'],
    { cwd: source, stdio: 'inherit' },
  )
  const artifact = join(source, 'zig-out/bin/ghostty-vt.wasm')
  if (!existsSync(artifact)) throw new Error('Ghostty did not emit a browser WASM module')
  const bytes = readFileSync(artifact)
  validateWasm(bytes)
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const temporaryOutput = join(OUTPUT_DIR, 'ghostty-vt.wasm.tmp')
  writeFileSync(temporaryOutput, bytes)
  renameSync(temporaryOutput, join(OUTPUT_DIR, 'ghostty-vt.wasm'))
  copyFileSync(join(source, 'LICENSE'), join(OUTPUT_DIR, 'ghostty-vt-LICENSE.txt'))
  writeFileSync(join(OUTPUT_DIR, 'ghostty-vt.revision'), `${GHOSTTY_WEB_ARTIFACT_ID}\n`)
  console.log(`Built Ghostty ${GHOSTTY_REVISION} WASM (${bytes.byteLength} bytes)`)
})
