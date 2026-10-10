/*!
 * @file        export/zip-writer.js
 * @description ZIP container writer (STORE method, no compression) for multi-file exports.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
(function () {
    'use strict';
    const ROOT = globalThis;

    // CRC-32 as ZIP defines it: reflected, polynomial 0xEDB88320.
    const CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c;
    }

    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    const ZipWriter = {
        /**
         * Packs files into one archive stored uncompressed (method 0): a valid
         * zip every unzipper opens, just no smaller than its contents. Names
         * are written as UTF-8 (flag bit 11) and must already be unique.
         * No ZIP64, so at most 65535 entries and 4 GiB in total.
         * @param {Array<{filename: string, blob: Blob}>} files
         * @returns {Promise<Blob>}
         */
        async build(files) {
            if (files.length > 0xFFFF) {
                throw new Error(`[ZipWriter] ${files.length} entries exceed the 65535 a zip without ZIP64 can hold.`);
            }
            const encoder = new TextEncoder();
            // MS-DOS timestamp: local time, 2-second resolution, years from 1980.
            const now = new Date();
            const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
            const dosDate = ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
            const body = [];
            const directory = [];
            let offset = 0;
            for (const file of files) {
                const name = encoder.encode(file.filename);
                const data = new Uint8Array(await file.blob.arrayBuffer());
                const crc = crc32(data);

                const local = new DataView(new ArrayBuffer(30));
                local.setUint32(0, 0x04034b50, true); // local file header
                local.setUint16(4, 10, true); // version needed: 1.0
                local.setUint16(6, 0x0800, true); // UTF-8 names
                local.setUint16(8, 0, true); // method: stored
                local.setUint16(10, dosTime, true);
                local.setUint16(12, dosDate, true);
                local.setUint32(14, crc, true);
                local.setUint32(18, data.length, true); // compressed size
                local.setUint32(22, data.length, true); // uncompressed size
                local.setUint16(26, name.length, true);
                body.push(local, name, data);

                const entry = new DataView(new ArrayBuffer(46));
                entry.setUint32(0, 0x02014b50, true); // central directory header
                entry.setUint16(4, 20, true); // made by: spec 2.0, MS-DOS
                entry.setUint16(6, 10, true);
                entry.setUint16(8, 0x0800, true);
                entry.setUint16(10, 0, true);
                entry.setUint16(12, dosTime, true);
                entry.setUint16(14, dosDate, true);
                entry.setUint32(16, crc, true);
                entry.setUint32(20, data.length, true);
                entry.setUint32(24, data.length, true);
                entry.setUint16(28, name.length, true);
                entry.setUint32(42, offset, true);      // where this file's local header starts
                directory.push(entry, name);

                offset += 30 + name.length + data.length;
            }
            const directorySize = directory.reduce((sum, part) => sum + part.byteLength, 0);
            if (offset + directorySize > 0xFFFFFFFF) {
                throw new Error('[ZipWriter] Archive exceeds 4 GiB, which needs ZIP64.');
            }
            const end = new DataView(new ArrayBuffer(22));
            end.setUint32(0, 0x06054b50, true); // end of central directory
            end.setUint16(8, files.length, true); // entries on this disk
            end.setUint16(10, files.length, true); // entries in total
            end.setUint32(12, directorySize, true);
            end.setUint32(16, offset, true); // where the central directory starts
            return new Blob([...body, ...directory, end], { type: 'application/zip' });
        },
    };

    ROOT.ZipWriter = ZipWriter;
})();