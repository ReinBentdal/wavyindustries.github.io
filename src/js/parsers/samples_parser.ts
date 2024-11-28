// Define constants
export const TICKS_PER_BEAT = 24; // 24 ticks per beat
export const NUM_PAGES = 10;
export const LOOPS_PER_PAGE = 15;

class ByteArray {
    data: number[];

    constructor() {
        this.data = [];
    }

    push8(value: number): void {
        if (value < 0 || value > 0xFF) {
            throw new RangeError(`Value ${value} is out of range for an 8-bit unsigned integer`);
        }
        this.data.push(value & 0xFF);
    }

    push16(value: number): void {
        if (value < 0 || value > 0xFFFF) {
            throw new RangeError(`Value ${value} is out of range for a 16-bit unsigned integer`);
        }
        this.data.push(value & 0xFF);
        this.data.push((value >> 8) & 0xFF);
    }

    push32(value: number): void {
        if (value < 0 || value > 0xFFFFFFFF) {
            throw new RangeError(`Value ${value} is out of range for a 32-bit unsigned integer`);
        }
        this.data.push(value & 0xFF);
        this.data.push((value >> 8) & 0xFF);
        this.data.push((value >> 16) & 0xFF);
        this.data.push((value >> 24) & 0xFF);
    }

    pop8(): number {
        if (this.data.length < 1) {
            throw new RangeError("Attempted to pop from an empty array");
        }
        return this.data.shift()!;
    }

    pop16(): number {
        if (this.data.length < 2) {
            throw new RangeError("Not enough data to pop 16 bits");
        }
        const lsb = this.data.shift()!;
        const msb = this.data.shift()!;
        return lsb | (msb << 8);
    }

    pop32(): number {
        if (this.data.length < 4) {
            throw new RangeError("Not enough data to pop 32 bits");
        }
        const b0 = this.data.shift()!;
        const b1 = this.data.shift()!;
        const b2 = this.data.shift()!;
        const b3 = this.data.shift()!;
        let value = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
        return value >>> 0; // force unsigned interpretation
    }

    add(other: ByteArray): void {
        this.data.push(...other.data);
    }

    static from(array: Uint8Array): ByteArray {
        const byteArray = new ByteArray();
        byteArray.data = Array.from(array); // Convert Uint8Array to a regular array
        return byteArray;
    }
}

// Define event type
export interface NoteEvent {
    note: number; // int8_t
    state: number;
    velocity: number;
}

// Tuple of note event and time ticks
export type NoteEventTime = [number, NoteEvent];

// Define loop data structure
export interface LoopData {
    length_beats: number;
    events: NoteEventTime[];
}

// Define the type for pages, each page is an array of loops
export interface Page {
    id: number // uint16_t
    loops: LoopData[]
}

// Define the sample pack type
export interface SamplePack {
    // storage metadata
    reserved0?: number; // uint32_t
    reserved1?: number; // uint32_t
    reserved2?: number; // uint32_t
    reserved3?: number; // uint32_t

    // Pack content
    pages: Page[];
}

export function samplesParser_encode(samplePack: SamplePack): Uint8Array {
    let d = new ByteArray()

    // write header
    d.push32(samplePack.reserved0)
    d.push32(samplePack.reserved1)
    d.push32(samplePack.reserved2)
    d.push32(samplePack.reserved3)

    for (let i = 0; i < NUM_PAGES; i++) {
        d.push16(samplePack.pages[i].id)
    }

    // gather offsets and loop data, then combine into main array
    let loopOffsets = new ByteArray()
    let loopData = new ByteArray()
    for (let page_idx = 0; page_idx < NUM_PAGES; page_idx++) {
        let page = samplePack.pages[page_idx]
        for (let loop_idx = 0; loop_idx < LOOPS_PER_PAGE; loop_idx++) {
            let loop = page.loops[loop_idx]
            if (loop == null) {
                loopOffsets.push16(0xFFFF)
                continue
            }
            loopOffsets.push16(loopData.data.length) // offset relative to start of data

            loopData.push8(loop.length_beats) // loop length
            loopData.push8(loop.events.length) // number of events
            for (const event of loop.events) {
                const [ticks, noteEvent] = event;
                loopData.push8(noteEvent.note & 0x7F)
                const data = (noteEvent.state << 7) | (noteEvent.velocity & 0x7F);
                loopData.push8(data);
                loopData.push16(ticks);
            }
        }
    }

    d.add(loopOffsets)
    d.add(loopData)

    return Uint8Array.from(d.data)
}

export function samplesParser_decode(packedData: Uint8Array): SamplePack {
    let d = ByteArray.from(packedData)
    let p: SamplePack = {
        reserved0: d.pop32(),
        reserved1: d.pop32(),
        reserved2: d.pop32(),
        reserved3: d.pop32(),
        pages: [],
    }

    // extract page IDs
    for (let i = 0; i < NUM_PAGES; i++) {
        p.pages.push({ id: d.pop16(), loops: [] })
    }

    // remove offsets, only interested in loop is set or not
    let loopExists: boolean[] = []
    for (let i = 0; i < NUM_PAGES * LOOPS_PER_PAGE; i++) {
        loopExists.push(d.pop16() === 0xFFFF ? false : true)
    }

    for (let page_idx = 0; page_idx < NUM_PAGES; page_idx++) {
        let page = p.pages[page_idx]
        for (let loop_idx = 0; loop_idx < LOOPS_PER_PAGE; loop_idx++) {

            if (loopExists[page_idx * NUM_PAGES + loop_idx] == false) {
                page.loops.push(null)
                continue
            }

            let loop: LoopData = {
                length_beats: d.pop8(),
                events: []
            }
            let numEvents = d.pop8()
            for (let i = 0; i < numEvents; i++) {
                let note = d.pop8() & 0x7F
                let data = d.pop8()
                let state = (data >> 7) & 0x01;
                let velocity = data & 0x7F;
                let ticks = d.pop16()
                loop.events.push([ticks, { note: note, state: state, velocity: velocity }])
            }
            page.loops.push(loop)
        }
    }

    return p
}

export function getPageByteSize(page: Page): number {
    let size = 0;
    page.loops.forEach((loop) => {
        if (loop == null) return;
        size += 1; // add for loop length
        size += 1; // add for number of events (max255)
        loop?.events?.forEach((_) => {
            size += 4 // each note is 4 bytes
        })
    })
    return size;
}

export function getPackSize(pack: SamplePack): number {
    let size = 0;
    // dont include reserved as its part of the fixed data
    pack.pages.forEach((page) => size += getPageByteSize(page))
    return size;
}

export function generateOGPage(): Page {
    return {
        id: 0xDEAD,
        loops: [
            {
                length_beats: 4,
                events: [
                    [0, { note: 36, state: 1, velocity: 99 }],
                    [0, { note: 42, state: 1, velocity: 99 }],
                    [4, { note: 42, state: 0, velocity: 99 }],
                    [12, { note: 36, state: 0, velocity: 99 }],
                    [12, { note: 42, state: 1, velocity: 99 }],
                    [16, { note: 42, state: 0, velocity: 99 }],
                    [24, { note: 42, state: 1, velocity: 99 }],
                    [24, { note: 38, state: 1, velocity: 99 }],
                    [28, { note: 42, state: 0, velocity: 99 }],
                    [28, { note: 38, state: 0, velocity: 99 }],
                    [36, { note: 42, state: 1, velocity: 99 }],
                    [40, { note: 42, state: 0, velocity: 99 }],
                    [42, { note: 36, state: 1, velocity: 99 }],
                    [46, { note: 36, state: 0, velocity: 99 }],
                    [48, { note: 42, state: 1, velocity: 99 }],
                    [52, { note: 42, state: 0, velocity: 99 }],
                    [54, { note: 36, state: 1, velocity: 99 }],
                    [58, { note: 36, state: 0, velocity: 99 }],
                    [60, { note: 36, state: 1, velocity: 99 }],
                    [60, { note: 42, state: 1, velocity: 99 }],
                    [64, { note: 42, state: 0, velocity: 99 }],
                    [72, { note: 36, state: 0, velocity: 99 }],
                    [72, { note: 38, state: 1, velocity: 99 }],
                    [72, { note: 42, state: 1, velocity: 99 }],
                    [76, { note: 42, state: 0, velocity: 99 }],
                    [84, { note: 38, state: 0, velocity: 99 }],
                    [84, { note: 42, state: 1, velocity: 99 }],
                    [88, { note: 42, state: 0, velocity: 99 }],
                    [90, { note: 46, state: 1, velocity: 99 }],
                    [94, { note: 46, state: 0, velocity: 99 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 36, state: 1, velocity: 122 }],
                    [0, { note: 42, state: 1, velocity: 114 }],
                    [6, { note: 42, state: 0, velocity: 114 }],
                    [12, { note: 36, state: 0, velocity: 122 }],
                    [12, { note: 37, state: 1, velocity: 126 }],
                    [12, { note: 42, state: 1, velocity: 100 }],
                    [18, { note: 37, state: 0, velocity: 126 }],
                    [18, { note: 42, state: 0, velocity: 100 }],
                    [18, { note: 36, state: 1, velocity: 122 }],
                    [19, { note: 36, state: 0, velocity: 122 }],
                    [24, { note: 36, state: 1, velocity: 122 }],
                    [24, { note: 42, state: 1, velocity: 114 }],
                    [25, { note: 42, state: 0, velocity: 114 }],
                    [30, { note: 37, state: 1, velocity: 114 }],
                    [36, { note: 36, state: 0, velocity: 122 }],
                    [36, { note: 37, state: 0, velocity: 114 }],
                    [36, { note: 42, state: 1, velocity: 85 }],
                    [37, { note: 42, state: 0, velocity: 85 }],
                    [42, { note: 36, state: 1, velocity: 126 }],
                    [43, { note: 36, state: 0, velocity: 126 }],
                    [48, { note: 36, state: 1, velocity: 122 }],
                    [48, { note: 37, state: 1, velocity: 126 }],
                    [48, { note: 42, state: 1, velocity: 126 }],
                    [54, { note: 37, state: 0, velocity: 126 }],
                    [54, { note: 42, state: 0, velocity: 126 }],
                    [60, { note: 36, state: 0, velocity: 122 }],
                    [60, { note: 42, state: 1, velocity: 50 }],
                    [61, { note: 42, state: 0, velocity: 50 }],
                    [66, { note: 37, state: 1, velocity: 126 }],
                    [66, { note: 36, state: 1, velocity: 126 }],
                    [72, { note: 37, state: 0, velocity: 126 }],
                    [72, { note: 36, state: 0, velocity: 126 }],
                    [72, { note: 42, state: 1, velocity: 126 }],
                    [72, { note: 36, state: 1, velocity: 126 }],
                    [78, { note: 42, state: 0, velocity: 126 }],
                    [84, { note: 36, state: 0, velocity: 126 }],
                    [84, { note: 42, state: 1, velocity: 77 }],
                    [84, { note: 37, state: 1, velocity: 126 }],
                    [85, { note: 42, state: 0, velocity: 77 }],
                    [90, { note: 37, state: 0, velocity: 126 }],
                    [90, { note: 46, state: 1, velocity: 114 }],
                    [90, { note: 36, state: 1, velocity: 126 }],
                    [91, { note: 46, state: 0, velocity: 114 }],
                    [91, { note: 36, state: 0, velocity: 126 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 42, state: 1, velocity: 85 }],
                    [0, { note: 36, state: 1, velocity: 99 }],
                    [0, { note: 55, state: 1, velocity: 97 }],
                    [6, { note: 42, state: 0, velocity: 85 }],
                    [6, { note: 36, state: 0, velocity: 99 }],
                    [6, { note: 55, state: 0, velocity: 97 }],
                    [6, { note: 36, state: 1, velocity: 56 }],
                    [12, { note: 36, state: 0, velocity: 56 }],
                    [12, { note: 42, state: 1, velocity: 25 }],
                    [18, { note: 42, state: 0, velocity: 25 }],
                    [18, { note: 36, state: 1, velocity: 109 }],
                    [24, { note: 36, state: 0, velocity: 109 }],
                    [24, { note: 38, state: 1, velocity: 104 }],
                    [24, { note: 42, state: 1, velocity: 67 }],
                    [25, { note: 38, state: 0, velocity: 104 }],
                    [30, { note: 42, state: 0, velocity: 67 }],
                    [30, { note: 38, state: 1, velocity: 74 }],
                    [31, { note: 38, state: 0, velocity: 74 }],
                    [36, { note: 42, state: 1, velocity: 67 }],
                    [42, { note: 42, state: 0, velocity: 67 }],
                    [42, { note: 38, state: 1, velocity: 53 }],
                    [48, { note: 38, state: 0, velocity: 53 }],
                    [48, { note: 42, state: 1, velocity: 85 }],
                    [54, { note: 42, state: 0, velocity: 85 }],
                    [54, { note: 38, state: 1, velocity: 31 }],
                    [60, { note: 38, state: 0, velocity: 31 }],
                    [60, { note: 42, state: 1, velocity: 85 }],
                    [60, { note: 36, state: 1, velocity: 98 }],
                    [66, { note: 36, state: 0, velocity: 98 }],
                    [66, { note: 42, state: 0, velocity: 85 }],
                    [72, { note: 42, state: 1, velocity: 77 }],
                    [78, { note: 42, state: 0, velocity: 77 }],
                    [78, { note: 38, state: 1, velocity: 94 }],
                    [84, { note: 38, state: 0, velocity: 94 }],
                    [84, { note: 42, state: 1, velocity: 77 }],
                    [90, { note: 42, state: 0, velocity: 77 }],
                    [90, { note: 38, state: 1, velocity: 94 }],
                    [96, { note: 38, state: 0, velocity: 94 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 36, state: 1, velocity: 122 }],
                    [0, { note: 42, state: 1, velocity: 114 }],
                    [4, { note: 36, state: 0, velocity: 122 }],
                    [4, { note: 42, state: 0, velocity: 114 }],
                    [8, { note: 42, state: 1, velocity: 62 }],
                    [12, { note: 42, state: 0, velocity: 62 }],
                    [16, { note: 42, state: 1, velocity: 89 }],
                    [17, { note: 42, state: 0, velocity: 89 }],
                    [24, { note: 42, state: 1, velocity: 114 }],
                    [24, { note: 38, state: 1, velocity: 114 }],
                    [28, { note: 42, state: 0, velocity: 114 }],
                    [28, { note: 38, state: 0, velocity: 114 }],
                    [32, { note: 42, state: 1, velocity: 77 }],
                    [36, { note: 42, state: 0, velocity: 77 }],
                    [40, { note: 42, state: 1, velocity: 107 }],
                    [44, { note: 42, state: 0, velocity: 107 }],
                    [48, { note: 42, state: 1, velocity: 114 }],
                    [48, { note: 36, state: 1, velocity: 126 }],
                    [52, { note: 42, state: 0, velocity: 114 }],
                    [52, { note: 36, state: 0, velocity: 126 }],
                    [56, { note: 42, state: 1, velocity: 85 }],
                    [60, { note: 42, state: 0, velocity: 85 }],
                    [64, { note: 42, state: 1, velocity: 100 }],
                    [65, { note: 42, state: 0, velocity: 100 }],
                    [72, { note: 42, state: 1, velocity: 114 }],
                    [72, { note: 38, state: 1, velocity: 122 }],
                    [76, { note: 42, state: 0, velocity: 114 }],
                    [76, { note: 38, state: 0, velocity: 122 }],
                    [80, { note: 42, state: 1, velocity: 95 }],
                    [81, { note: 42, state: 0, velocity: 95 }],
                    [88, { note: 42, state: 1, velocity: 107 }],
                    [88, { note: 36, state: 1, velocity: 109 }],
                    [89, { note: 42, state: 0, velocity: 107 }],
                    [89, { note: 36, state: 0, velocity: 109 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 36, state: 1, velocity: 114 }],
                    [0, { note: 42, state: 1, velocity: 95 }],
                    [4, { note: 36, state: 0, velocity: 114 }],
                    [4, { note: 42, state: 0, velocity: 95 }],
                    [12, { note: 42, state: 1, velocity: 90 }],
                    [12, { note: 36, state: 1, velocity: 110 }],
                    [16, { note: 42, state: 0, velocity: 90 }],
                    [16, { note: 36, state: 0, velocity: 110 }],
                    [24, { note: 37, state: 1, velocity: 73 }],
                    [24, { note: 42, state: 1, velocity: 95 }],
                    [28, { note: 37, state: 0, velocity: 73 }],
                    [28, { note: 42, state: 0, velocity: 95 }],
                    [36, { note: 42, state: 1, velocity: 70 }],
                    [40, { note: 42, state: 0, velocity: 70 }],
                    [48, { note: 36, state: 1, velocity: 116 }],
                    [48, { note: 42, state: 1, velocity: 87 }],
                    [52, { note: 36, state: 0, velocity: 116 }],
                    [52, { note: 42, state: 0, velocity: 87 }],
                    [60, { note: 36, state: 1, velocity: 114 }],
                    [60, { note: 42, state: 1, velocity: 88 }],
                    [64, { note: 36, state: 0, velocity: 114 }],
                    [64, { note: 42, state: 0, velocity: 88 }],
                    [72, { note: 37, state: 1, velocity: 69 }],
                    [72, { note: 42, state: 1, velocity: 73 }],
                    [76, { note: 37, state: 0, velocity: 69 }],
                    [76, { note: 42, state: 0, velocity: 73 }],
                    [84, { note: 46, state: 1, velocity: 91 }],
                    [88, { note: 46, state: 0, velocity: 91 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 42, state: 1, velocity: 88 }],
                    [0, { note: 36, state: 1, velocity: 88 }],
                    [2, { note: 42, state: 0, velocity: 88 }],
                    [2, { note: 36, state: 0, velocity: 88 }],
                    [12, { note: 46, state: 1, velocity: 67 }],
                    [14, { note: 46, state: 0, velocity: 67 }],
                    [24, { note: 42, state: 1, velocity: 80 }],
                    [24, { note: 37, state: 1, velocity: 115 }],
                    [26, { note: 42, state: 0, velocity: 80 }],
                    [26, { note: 37, state: 0, velocity: 115 }],
                    [36, { note: 42, state: 1, velocity: 77 }],
                    [36, { note: 36, state: 1, velocity: 47 }],
                    [38, { note: 42, state: 0, velocity: 77 }],
                    [38, { note: 36, state: 0, velocity: 47 }],
                    [48, { note: 46, state: 1, velocity: 79 }],
                    [48, { note: 36, state: 1, velocity: 87 }],
                    [50, { note: 46, state: 0, velocity: 79 }],
                    [50, { note: 36, state: 0, velocity: 87 }],
                    [60, { note: 42, state: 1, velocity: 70 }],
                    [62, { note: 42, state: 0, velocity: 70 }],
                    [72, { note: 42, state: 1, velocity: 67 }],
                    [72, { note: 37, state: 1, velocity: 113 }],
                    [74, { note: 42, state: 0, velocity: 67 }],
                    [74, { note: 37, state: 0, velocity: 113 }],
                    [84, { note: 42, state: 1, velocity: 79 }],
                    [84, { note: 36, state: 1, velocity: 48 }],
                    [86, { note: 42, state: 0, velocity: 79 }],
                    [86, { note: 36, state: 0, velocity: 48 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 46, state: 1, velocity: 84 }],
                    [0, { note: 36, state: 1, velocity: 108 }],
                    [0, { note: 37, state: 1, velocity: 107 }],
                    [4, { note: 46, state: 0, velocity: 84 }],
                    [4, { note: 36, state: 0, velocity: 108 }],
                    [4, { note: 37, state: 0, velocity: 107 }],
                    [8, { note: 42, state: 1, velocity: 92 }],
                    [12, { note: 42, state: 0, velocity: 92 }],
                    [16, { note: 37, state: 1, velocity: 84 }],
                    [20, { note: 37, state: 0, velocity: 84 }],
                    [24, { note: 38, state: 1, velocity: 108 }],
                    [24, { note: 37, state: 1, velocity: 90 }],
                    [24, { note: 42, state: 1, velocity: 93 }],
                    [28, { note: 38, state: 0, velocity: 108 }],
                    [28, { note: 37, state: 0, velocity: 90 }],
                    [28, { note: 42, state: 0, velocity: 93 }],
                    [40, { note: 37, state: 1, velocity: 89 }],
                    [44, { note: 37, state: 0, velocity: 89 }],
                    [48, { note: 42, state: 1, velocity: 81 }],
                    [48, { note: 36, state: 1, velocity: 105 }],
                    [48, { note: 37, state: 1, velocity: 79 }],
                    [52, { note: 42, state: 0, velocity: 81 }],
                    [52, { note: 36, state: 0, velocity: 105 }],
                    [52, { note: 37, state: 0, velocity: 79 }],
                    [64, { note: 37, state: 1, velocity: 84 }],
                    [68, { note: 37, state: 0, velocity: 84 }],
                    [72, { note: 38, state: 1, velocity: 109 }],
                    [72, { note: 37, state: 1, velocity: 85 }],
                    [72, { note: 42, state: 1, velocity: 88 }],
                    [76, { note: 38, state: 0, velocity: 109 }],
                    [76, { note: 37, state: 0, velocity: 85 }],
                    [76, { note: 42, state: 0, velocity: 88 }],
                    [88, { note: 37, state: 1, velocity: 87 }],
                    [92, { note: 37, state: 0, velocity: 87 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 44, state: 1, velocity: 93 }],
                    [0, { note: 36, state: 1, velocity: 116 }],
                    [3, { note: 44, state: 0, velocity: 64 }],
                    [3, { note: 36, state: 0, velocity: 64 }],
                    [6, { note: 44, state: 1, velocity: 93 }],
                    [9, { note: 44, state: 0, velocity: 64 }],
                    [12, { note: 46, state: 1, velocity: 94 }],
                    [15, { note: 46, state: 0, velocity: 64 }],
                    [24, { note: 40, state: 1, velocity: 118 }],
                    [24, { note: 44, state: 1, velocity: 88 }],
                    [24, { note: 36, state: 1, velocity: 116 }],
                    [27, { note: 40, state: 0, velocity: 64 }],
                    [27, { note: 44, state: 0, velocity: 64 }],
                    [27, { note: 36, state: 0, velocity: 64 }],
                    [36, { note: 46, state: 1, velocity: 96 }],
                    [39, { note: 46, state: 0, velocity: 64 }],
                    [48, { note: 44, state: 1, velocity: 94 }],
                    [48, { note: 36, state: 1, velocity: 116 }],
                    [51, { note: 44, state: 0, velocity: 64 }],
                    [51, { note: 36, state: 0, velocity: 64 }],
                    [54, { note: 44, state: 1, velocity: 89 }],
                    [57, { note: 44, state: 0, velocity: 64 }],
                    [60, { note: 46, state: 1, velocity: 93 }],
                    [63, { note: 46, state: 0, velocity: 64 }],
                    [72, { note: 44, state: 1, velocity: 98 }],
                    [72, { note: 40, state: 1, velocity: 118 }],
                    [72, { note: 36, state: 1, velocity: 116 }],
                    [75, { note: 44, state: 0, velocity: 64 }],
                    [75, { note: 40, state: 0, velocity: 64 }],
                    [75, { note: 36, state: 0, velocity: 64 }],
                    [84, { note: 46, state: 1, velocity: 92 }],
                    [87, { note: 46, state: 0, velocity: 64 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 42, state: 1, velocity: 114 }],
                    [0, { note: 36, state: 1, velocity: 114 }],
                    [6, { note: 42, state: 0, velocity: 114 }],
                    [6, { note: 36, state: 0, velocity: 114 }],
                    [12, { note: 42, state: 1, velocity: 100 }],
                    [12, { note: 36, state: 1, velocity: 104 }],
                    [18, { note: 42, state: 0, velocity: 100 }],
                    [18, { note: 36, state: 0, velocity: 104 }],
                    [24, { note: 42, state: 1, velocity: 114 }],
                    [24, { note: 38, state: 1, velocity: 126 }],
                    [30, { note: 42, state: 0, velocity: 114 }],
                    [30, { note: 38, state: 0, velocity: 126 }],
                    [36, { note: 42, state: 1, velocity: 73 }],
                    [37, { note: 42, state: 0, velocity: 73 }],
                    [42, { note: 38, state: 1, velocity: 99 }],
                    [48, { note: 38, state: 0, velocity: 99 }],
                    [48, { note: 36, state: 1, velocity: 122 }],
                    [48, { note: 42, state: 1, velocity: 107 }],
                    [54, { note: 36, state: 0, velocity: 122 }],
                    [60, { note: 42, state: 0, velocity: 107 }],
                    [60, { note: 42, state: 1, velocity: 100 }],
                    [60, { note: 36, state: 1, velocity: 109 }],
                    [66, { note: 42, state: 0, velocity: 100 }],
                    [66, { note: 36, state: 0, velocity: 109 }],
                    [66, { note: 37, state: 0, velocity: 0 }],
                    [66, { note: 37, state: 0, velocity: 0 }],
                    [67, { note: 37, state: 1, velocity: 5 }],
                    [67, { note: 37, state: 0, velocity: 5 }],
                    [68, { note: 37, state: 1, velocity: 10 }],
                    [68, { note: 37, state: 0, velocity: 10 }],
                    [68, { note: 37, state: 1, velocity: 15 }],
                    [69, { note: 37, state: 0, velocity: 15 }],
                    [69, { note: 37, state: 1, velocity: 20 }],
                    [70, { note: 37, state: 0, velocity: 20 }],
                    [70, { note: 37, state: 1, velocity: 26 }],
                    [70, { note: 37, state: 0, velocity: 26 }],
                    [70, { note: 37, state: 1, velocity: 31 }],
                    [71, { note: 37, state: 0, velocity: 31 }],
                    [71, { note: 37, state: 1, velocity: 36 }],
                    [72, { note: 37, state: 0, velocity: 36 }],
                    [72, { note: 37, state: 1, velocity: 41 }],
                    [72, { note: 37, state: 0, velocity: 41 }],
                    [73, { note: 37, state: 1, velocity: 46 }],
                    [73, { note: 37, state: 0, velocity: 46 }],
                    [74, { note: 37, state: 1, velocity: 52 }],
                    [74, { note: 37, state: 0, velocity: 52 }],
                    [74, { note: 37, state: 1, velocity: 57 }],
                    [75, { note: 37, state: 0, velocity: 57 }],
                    [75, { note: 37, state: 1, velocity: 61 }],
                    [76, { note: 37, state: 0, velocity: 61 }],
                    [76, { note: 37, state: 1, velocity: 66 }],
                    [76, { note: 37, state: 0, velocity: 66 }],
                    [76, { note: 37, state: 1, velocity: 71 }],
                    [77, { note: 37, state: 0, velocity: 71 }],
                    [77, { note: 37, state: 1, velocity: 77 }],
                    [78, { note: 37, state: 0, velocity: 77 }],
                    [78, { note: 37, state: 1, velocity: 82 }],
                    [78, { note: 37, state: 0, velocity: 82 }],
                    [79, { note: 37, state: 1, velocity: 87 }],
                    [79, { note: 37, state: 0, velocity: 87 }],
                    [80, { note: 37, state: 1, velocity: 92 }],
                    [80, { note: 37, state: 0, velocity: 92 }],
                    [80, { note: 37, state: 1, velocity: 97 }],
                    [81, { note: 37, state: 0, velocity: 97 }],
                    [81, { note: 37, state: 1, velocity: 103 }],
                    [82, { note: 37, state: 0, velocity: 103 }],
                    [82, { note: 37, state: 1, velocity: 108 }],
                    [82, { note: 37, state: 0, velocity: 108 }],
                    [82, { note: 37, state: 1, velocity: 113 }],
                    [83, { note: 37, state: 0, velocity: 113 }],
                    [83, { note: 37, state: 1, velocity: 118 }],
                    [84, { note: 37, state: 0, velocity: 118 }],
                    [84, { note: 38, state: 1, velocity: 111 }],
                    [85, { note: 38, state: 0, velocity: 111 }],
                    [86, { note: 38, state: 1, velocity: 118 }],
                    [87, { note: 38, state: 0, velocity: 118 }],
                    [87, { note: 38, state: 1, velocity: 107 }],
                    [88, { note: 38, state: 0, velocity: 107 }],
                    [88, { note: 38, state: 1, velocity: 96 }],
                    [90, { note: 38, state: 0, velocity: 96 }],
                    [90, { note: 38, state: 1, velocity: 85 }],
                    [91, { note: 38, state: 0, velocity: 85 }],
                    [92, { note: 38, state: 1, velocity: 75 }],
                    [93, { note: 38, state: 0, velocity: 75 }],
                    [93, { note: 38, state: 1, velocity: 64 }],
                    [94, { note: 38, state: 0, velocity: 64 }],
                    [94, { note: 38, state: 1, velocity: 54 }],
                    [96, { note: 38, state: 0, velocity: 54 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 51, state: 1, velocity: 95 }],
                    [6, { note: 51, state: 0, velocity: 95 }],
                    [12, { note: 51, state: 1, velocity: 100 }],
                    [13, { note: 51, state: 0, velocity: 100 }],
                    [24, { note: 38, state: 1, velocity: 126 }],
                    [24, { note: 51, state: 1, velocity: 126 }],
                    [30, { note: 38, state: 0, velocity: 126 }],
                    [30, { note: 51, state: 0, velocity: 126 }],
                    [36, { note: 51, state: 1, velocity: 89 }],
                    [37, { note: 51, state: 0, velocity: 89 }],
                    [42, { note: 51, state: 1, velocity: 114 }],
                    [43, { note: 51, state: 0, velocity: 114 }],
                    [48, { note: 51, state: 1, velocity: 126 }],
                    [54, { note: 51, state: 0, velocity: 126 }],
                    [60, { note: 45, state: 1, velocity: 126 }],
                    [60, { note: 51, state: 1, velocity: 126 }],
                    [66, { note: 45, state: 0, velocity: 126 }],
                    [66, { note: 51, state: 0, velocity: 126 }],
                    [72, { note: 51, state: 1, velocity: 100 }],
                    [73, { note: 51, state: 0, velocity: 100 }],
                    [84, { note: 51, state: 1, velocity: 107 }],
                    [84, { note: 45, state: 1, velocity: 126 }],
                    [90, { note: 51, state: 0, velocity: 107 }],
                    [90, { note: 45, state: 0, velocity: 126 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 36, state: 1, velocity: 99 }],
                    [0, { note: 42, state: 1, velocity: 99 }],
                    [4, { note: 36, state: 0, velocity: 99 }],
                    [4, { note: 42, state: 0, velocity: 99 }],
                    [8, { note: 42, state: 1, velocity: 61 }],
                    [12, { note: 42, state: 0, velocity: 61 }],
                    [12, { note: 42, state: 1, velocity: 99 }],
                    [12, { note: 46, state: 1, velocity: 62 }],
                    [16, { note: 42, state: 0, velocity: 99 }],
                    [16, { note: 46, state: 0, velocity: 62 }],
                    [20, { note: 42, state: 1, velocity: 61 }],
                    [24, { note: 42, state: 0, velocity: 61 }],
                    [24, { note: 42, state: 1, velocity: 99 }],
                    [24, { note: 40, state: 1, velocity: 99 }],
                    [24, { note: 38, state: 1, velocity: 77 }],
                    [28, { note: 42, state: 0, velocity: 99 }],
                    [28, { note: 40, state: 0, velocity: 99 }],
                    [28, { note: 38, state: 0, velocity: 77 }],
                    [32, { note: 42, state: 1, velocity: 61 }],
                    [36, { note: 42, state: 0, velocity: 61 }],
                    [36, { note: 37, state: 1, velocity: 77 }],
                    [36, { note: 42, state: 1, velocity: 99 }],
                    [36, { note: 46, state: 1, velocity: 62 }],
                    [40, { note: 37, state: 0, velocity: 77 }],
                    [40, { note: 42, state: 0, velocity: 99 }],
                    [40, { note: 46, state: 0, velocity: 62 }],
                    [44, { note: 37, state: 1, velocity: 48 }],
                    [44, { note: 42, state: 1, velocity: 61 }],
                    [48, { note: 37, state: 0, velocity: 48 }],
                    [48, { note: 42, state: 0, velocity: 61 }],
                    [48, { note: 42, state: 1, velocity: 99 }],
                    [48, { note: 36, state: 1, velocity: 99 }],
                    [52, { note: 42, state: 0, velocity: 99 }],
                    [52, { note: 36, state: 0, velocity: 99 }],
                    [56, { note: 37, state: 1, velocity: 62 }],
                    [56, { note: 42, state: 1, velocity: 61 }],
                    [60, { note: 37, state: 0, velocity: 62 }],
                    [60, { note: 42, state: 0, velocity: 61 }],
                    [60, { note: 37, state: 1, velocity: 77 }],
                    [60, { note: 42, state: 1, velocity: 99 }],
                    [60, { note: 46, state: 1, velocity: 62 }],
                    [64, { note: 46, state: 0, velocity: 62 }],
                    [64, { note: 37, state: 0, velocity: 77 }],
                    [64, { note: 42, state: 0, velocity: 99 }],
                    [68, { note: 38, state: 1, velocity: 77 }],
                    [68, { note: 40, state: 1, velocity: 99 }],
                    [68, { note: 42, state: 1, velocity: 61 }],
                    [68, { note: 46, state: 1, velocity: 62 }],
                    [72, { note: 38, state: 0, velocity: 77 }],
                    [72, { note: 40, state: 0, velocity: 99 }],
                    [72, { note: 42, state: 0, velocity: 61 }],
                    [72, { note: 46, state: 0, velocity: 62 }],
                    [72, { note: 42, state: 1, velocity: 99 }],
                    [76, { note: 42, state: 0, velocity: 99 }],
                    [80, { note: 42, state: 1, velocity: 61 }],
                    [84, { note: 42, state: 0, velocity: 61 }],
                    [84, { note: 42, state: 1, velocity: 99 }],
                    [88, { note: 42, state: 0, velocity: 99 }],
                    [92, { note: 42, state: 1, velocity: 61 }],
                    [92, { note: 36, state: 1, velocity: 77 }],
                    [96, { note: 42, state: 0, velocity: 61 }],
                    [96, { note: 36, state: 0, velocity: 77 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 42, state: 1, velocity: 95 }],
                    [0, { note: 36, state: 1, velocity: 95 }],
                    [4, { note: 42, state: 0, velocity: 95 }],
                    [4, { note: 36, state: 0, velocity: 95 }],
                    [6, { note: 42, state: 1, velocity: 60 }],
                    [10, { note: 42, state: 0, velocity: 60 }],
                    [12, { note: 42, state: 1, velocity: 95 }],
                    [12, { note: 46, state: 1, velocity: 64 }],
                    [15, { note: 46, state: 0, velocity: 64 }],
                    [16, { note: 42, state: 0, velocity: 95 }],
                    [18, { note: 42, state: 1, velocity: 60 }],
                    [22, { note: 42, state: 0, velocity: 60 }],
                    [24, { note: 37, state: 1, velocity: 95 }],
                    [24, { note: 40, state: 1, velocity: 94 }],
                    [27, { note: 40, state: 0, velocity: 94 }],
                    [28, { note: 37, state: 0, velocity: 95 }],
                    [30, { note: 47, state: 1, velocity: 67 }],
                    [34, { note: 47, state: 0, velocity: 67 }],
                    [36, { note: 46, state: 1, velocity: 66 }],
                    [39, { note: 46, state: 0, velocity: 66 }],
                    [42, { note: 37, state: 1, velocity: 95 }],
                    [42, { note: 40, state: 1, velocity: 94 }],
                    [45, { note: 40, state: 0, velocity: 94 }],
                    [46, { note: 37, state: 0, velocity: 95 }],
                    [48, { note: 36, state: 1, velocity: 95 }],
                    [48, { note: 42, state: 1, velocity: 66 }],
                    [48, { note: 42, state: 1, velocity: 66 }],
                    [52, { note: 36, state: 0, velocity: 95 }],
                    [52, { note: 42, state: 0, velocity: 66 }],
                    [52, { note: 42, state: 0, velocity: 66 }],
                    [56, { note: 36, state: 1, velocity: 95 }],
                    [56, { note: 42, state: 1, velocity: 65 }],
                    [56, { note: 42, state: 1, velocity: 65 }],
                    [60, { note: 36, state: 0, velocity: 95 }],
                    [60, { note: 42, state: 0, velocity: 65 }],
                    [60, { note: 42, state: 0, velocity: 65 }],
                    [64, { note: 36, state: 1, velocity: 95 }],
                    [64, { note: 42, state: 1, velocity: 61 }],
                    [68, { note: 36, state: 0, velocity: 95 }],
                    [68, { note: 42, state: 0, velocity: 61 }],
                    [72, { note: 42, state: 1, velocity: 95 }],
                    [72, { note: 37, state: 1, velocity: 95 }],
                    [72, { note: 45, state: 1, velocity: 67 }],
                    [72, { note: 40, state: 1, velocity: 95 }],
                    [75, { note: 40, state: 0, velocity: 95 }],
                    [76, { note: 42, state: 0, velocity: 95 }],
                    [76, { note: 37, state: 0, velocity: 95 }],
                    [76, { note: 45, state: 0, velocity: 67 }],
                    [78, { note: 42, state: 1, velocity: 60 }],
                    [82, { note: 42, state: 0, velocity: 60 }],
                    [84, { note: 42, state: 1, velocity: 95 }],
                    [84, { note: 47, state: 1, velocity: 67 }],
                    [84, { note: 46, state: 1, velocity: 67 }],
                    [87, { note: 46, state: 0, velocity: 67 }],
                    [88, { note: 42, state: 0, velocity: 95 }],
                    [88, { note: 47, state: 0, velocity: 67 }],
                    [90, { note: 42, state: 1, velocity: 60 }],
                    [90, { note: 36, state: 1, velocity: 95 }],
                    [91, { note: 42, state: 0, velocity: 60 }],
                    [93, { note: 36, state: 0, velocity: 95 }],
                    [93, { note: 42, state: 1, velocity: 59 }],
                    [94, { note: 42, state: 0, velocity: 59 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 42, state: 1, velocity: 114 }],
                    [0, { note: 36, state: 1, velocity: 126 }],
                    [6, { note: 42, state: 0, velocity: 114 }],
                    [6, { note: 36, state: 0, velocity: 126 }],
                    [6, { note: 42, state: 1, velocity: 95 }],
                    [7, { note: 42, state: 0, velocity: 95 }],
                    [12, { note: 42, state: 1, velocity: 58 }],
                    [13, { note: 42, state: 0, velocity: 58 }],
                    [18, { note: 42, state: 1, velocity: 107 }],
                    [18, { note: 40, state: 1, velocity: 122 }],
                    [19, { note: 42, state: 0, velocity: 107 }],
                    [19, { note: 40, state: 0, velocity: 122 }],
                    [24, { note: 42, state: 1, velocity: 126 }],
                    [24, { note: 36, state: 1, velocity: 109 }],
                    [25, { note: 36, state: 0, velocity: 109 }],
                    [30, { note: 42, state: 0, velocity: 126 }],
                    [30, { note: 42, state: 1, velocity: 85 }],
                    [31, { note: 42, state: 0, velocity: 85 }],
                    [36, { note: 42, state: 1, velocity: 27 }],
                    [36, { note: 40, state: 1, velocity: 122 }],
                    [37, { note: 42, state: 0, velocity: 27 }],
                    [42, { note: 40, state: 0, velocity: 122 }],
                    [42, { note: 42, state: 1, velocity: 114 }],
                    [43, { note: 42, state: 0, velocity: 114 }],
                    [48, { note: 42, state: 1, velocity: 126 }],
                    [48, { note: 36, state: 1, velocity: 126 }],
                    [54, { note: 42, state: 0, velocity: 126 }],
                    [54, { note: 36, state: 0, velocity: 126 }],
                    [60, { note: 42, state: 1, velocity: 70 }],
                    [61, { note: 42, state: 0, velocity: 70 }],
                    [66, { note: 42, state: 1, velocity: 107 }],
                    [66, { note: 40, state: 1, velocity: 114 }],
                    [67, { note: 42, state: 0, velocity: 107 }],
                    [72, { note: 40, state: 0, velocity: 114 }],
                    [72, { note: 42, state: 1, velocity: 126 }],
                    [72, { note: 36, state: 1, velocity: 114 }],
                    [78, { note: 42, state: 0, velocity: 126 }],
                    [78, { note: 36, state: 0, velocity: 114 }],
                    [78, { note: 42, state: 1, velocity: 73 }],
                    [79, { note: 42, state: 0, velocity: 73 }],
                    [84, { note: 42, state: 1, velocity: 40 }],
                    [84, { note: 40, state: 1, velocity: 99 }],
                    [85, { note: 42, state: 0, velocity: 40 }],
                    [90, { note: 40, state: 0, velocity: 99 }],
                    [90, { note: 42, state: 1, velocity: 107 }],
                    [90, { note: 38, state: 1, velocity: 114 }],
                    [91, { note: 42, state: 0, velocity: 107 }],
                    [96, { note: 38, state: 0, velocity: 114 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 51, state: 1, velocity: 114 }],
                    [0, { note: 36, state: 1, velocity: 126 }],
                    [0, { note: 38, state: 1, velocity: 90 }],
                    [1, { note: 51, state: 0, velocity: 114 }],
                    [1, { note: 38, state: 0, velocity: 90 }],
                    [6, { note: 36, state: 0, velocity: 126 }],
                    [6, { note: 51, state: 1, velocity: 89 }],
                    [7, { note: 51, state: 0, velocity: 89 }],
                    [12, { note: 51, state: 1, velocity: 89 }],
                    [13, { note: 51, state: 0, velocity: 89 }],
                    [18, { note: 51, state: 1, velocity: 100 }],
                    [18, { note: 40, state: 1, velocity: 122 }],
                    [19, { note: 51, state: 0, velocity: 100 }],
                    [24, { note: 40, state: 0, velocity: 122 }],
                    [24, { note: 51, state: 1, velocity: 100 }],
                    [25, { note: 51, state: 0, velocity: 100 }],
                    [30, { note: 51, state: 1, velocity: 100 }],
                    [31, { note: 51, state: 0, velocity: 100 }],
                    [36, { note: 51, state: 1, velocity: 114 }],
                    [36, { note: 40, state: 1, velocity: 122 }],
                    [37, { note: 51, state: 0, velocity: 114 }],
                    [42, { note: 40, state: 0, velocity: 122 }],
                    [42, { note: 51, state: 1, velocity: 114 }],
                    [42, { note: 51, state: 1, velocity: 100 }],
                    [43, { note: 51, state: 0, velocity: 114 }],
                    [48, { note: 51, state: 0, velocity: 100 }],
                    [48, { note: 51, state: 1, velocity: 95 }],
                    [48, { note: 36, state: 1, velocity: 126 }],
                    [48, { note: 38, state: 1, velocity: 114 }],
                    [54, { note: 51, state: 0, velocity: 95 }],
                    [54, { note: 36, state: 0, velocity: 126 }],
                    [54, { note: 38, state: 0, velocity: 114 }],
                    [60, { note: 51, state: 1, velocity: 114 }],
                    [60, { note: 51, state: 1, velocity: 89 }],
                    [61, { note: 51, state: 0, velocity: 114 }],
                    [66, { note: 51, state: 0, velocity: 89 }],
                    [66, { note: 40, state: 1, velocity: 126 }],
                    [72, { note: 40, state: 0, velocity: 126 }],
                    [72, { note: 51, state: 1, velocity: 126 }],
                    [72, { note: 51, state: 1, velocity: 89 }],
                    [73, { note: 51, state: 0, velocity: 126 }],
                    [78, { note: 51, state: 0, velocity: 89 }],
                    [84, { note: 51, state: 1, velocity: 95 }],
                    [84, { note: 45, state: 1, velocity: 122 }],
                    [85, { note: 51, state: 0, velocity: 95 }],
                    [90, { note: 45, state: 0, velocity: 122 }],
                    [90, { note: 51, state: 1, velocity: 114 }],
                    [90, { note: 45, state: 1, velocity: 109 }],
                    [91, { note: 51, state: 0, velocity: 114 }],
                    [96, { note: 45, state: 0, velocity: 109 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 43, state: 1, velocity: 44 }],
                    [0, { note: 36, state: 1, velocity: 123 }],
                    [0, { note: 51, state: 1, velocity: 98 }],
                    [6, { note: 43, state: 0, velocity: 44 }],
                    [6, { note: 36, state: 0, velocity: 123 }],
                    [6, { note: 51, state: 0, velocity: 98 }],
                    [12, { note: 43, state: 1, velocity: 38 }],
                    [18, { note: 43, state: 0, velocity: 38 }],
                    [24, { note: 43, state: 1, velocity: 80 }],
                    [24, { note: 40, state: 1, velocity: 115 }],
                    [24, { note: 51, state: 1, velocity: 98 }],
                    [28, { note: 43, state: 0, velocity: 80 }],
                    [28, { note: 40, state: 0, velocity: 115 }],
                    [30, { note: 51, state: 0, velocity: 98 }],
                    [36, { note: 36, state: 1, velocity: 72 }],
                    [36, { note: 43, state: 1, velocity: 41 }],
                    [39, { note: 47, state: 1, velocity: 17 }],
                    [42, { note: 36, state: 0, velocity: 72 }],
                    [42, { note: 43, state: 0, velocity: 41 }],
                    [45, { note: 47, state: 0, velocity: 17 }],
                    [48, { note: 43, state: 1, velocity: 83 }],
                    [48, { note: 36, state: 1, velocity: 99 }],
                    [48, { note: 51, state: 1, velocity: 97 }],
                    [54, { note: 43, state: 0, velocity: 83 }],
                    [54, { note: 36, state: 0, velocity: 99 }],
                    [54, { note: 51, state: 0, velocity: 97 }],
                    [60, { note: 43, state: 1, velocity: 43 }],
                    [60, { note: 36, state: 1, velocity: 103 }],
                    [64, { note: 43, state: 0, velocity: 43 }],
                    [64, { note: 36, state: 0, velocity: 103 }],
                    [72, { note: 40, state: 1, velocity: 105 }],
                    [72, { note: 47, state: 1, velocity: 89 }],
                    [72, { note: 43, state: 1, velocity: 62 }],
                    [72, { note: 51, state: 1, velocity: 95 }],
                    [76, { note: 40, state: 0, velocity: 105 }],
                    [76, { note: 47, state: 0, velocity: 89 }],
                    [78, { note: 43, state: 0, velocity: 62 }],
                    [78, { note: 51, state: 0, velocity: 95 }],
                    [84, { note: 43, state: 1, velocity: 41 }],
                    [84, { note: 36, state: 1, velocity: 82 }],
                    [88, { note: 43, state: 0, velocity: 41 }],
                    [88, { note: 36, state: 0, velocity: 82 }]
                ]
            }
        ]
    }
}

function generateDummyPage2(): Page {
    return {
        id: 0xBEEF,
        loops: [
            {
                length_beats: 2,
                events: [
                    [0, { note: 42, state: 1, velocity: 59 }],
                    [0, { note: 36, state: 1, velocity: 81 }],
                    [12, { note: 42, state: 0, velocity: 64 }],
                    [12, { note: 36, state: 0, velocity: 64 }],
                    [12, { note: 42, state: 1, velocity: 81 }],
                    [24, { note: 42, state: 0, velocity: 64 }],
                    [24, { note: 42, state: 1, velocity: 59 }],
                    [24, { note: 38, state: 1, velocity: 81 }],
                    [24, { note: 36, state: 1, velocity: 81 }],
                    [36, { note: 42, state: 0, velocity: 64 }],
                    [36, { note: 38, state: 0, velocity: 64 }],
                    [36, { note: 36, state: 0, velocity: 64 }],
                    [36, { note: 42, state: 1, velocity: 81 }],
                    [48, { note: 42, state: 0, velocity: 64 }]
                ]
            },
            {
                length_beats: 4,
                events: [
                    [0, { note: 42, state: 1, velocity: 81 }],
                    [0, { note: 36, state: 1, velocity: 81 }],
                    [12, { note: 42, state: 0, velocity: 64 }],
                    [12, { note: 36, state: 0, velocity: 64 }],
                    [12, { note: 42, state: 1, velocity: 81 }],
                    [12, { note: 36, state: 1, velocity: 81 }],
                    [24, { note: 42, state: 0, velocity: 64 }],
                    [24, { note: 36, state: 0, velocity: 64 }],
                    [24, { note: 42, state: 1, velocity: 81 }],
                    [24, { note: 38, state: 1, velocity: 81 }],
                    [36, { note: 42, state: 0, velocity: 64 }],
                    [36, { note: 38, state: 0, velocity: 64 }],
                    [36, { note: 42, state: 1, velocity: 81 }],
                    [36, { note: 38, state: 1, velocity: 81 }],
                    [48, { note: 42, state: 0, velocity: 64 }],
                    [48, { note: 38, state: 0, velocity: 64 }],
                    [48, { note: 42, state: 1, velocity: 81 }],
                    [48, { note: 36, state: 1, velocity: 81 }],
                    [60, { note: 42, state: 0, velocity: 64 }],
                    [60, { note: 36, state: 0, velocity: 64 }],
                    [60, { note: 42, state: 1, velocity: 81 }],
                    [72, { note: 42, state: 0, velocity: 64 }],
                    [72, { note: 42, state: 1, velocity: 81 }],
                    [72, { note: 38, state: 1, velocity: 81 }],
                    [84, { note: 42, state: 0, velocity: 64 }],
                    [84, { note: 38, state: 0, velocity: 64 }],
                    [84, { note: 42, state: 1, velocity: 81 }],
                    [96, { note: 42, state: 0, velocity: 64 }]
                ]
            }
        ]
    }
}

export function generateDummySamples(): SamplePack {

    // Initialize pages
    const pages: Page[] = [];
    while (pages.length < 10) {
        const emptyPage: Page = {
            id: 0xFFFF,
            loops: new Array(LOOPS_PER_PAGE).fill(null),
        }
        pages.push(emptyPage);
    }

    pages[1] = generateOGPage()
    pages[2] = generateDummyPage2()

    // Create the SamplePack
    const samplePack: SamplePack = {
        reserved0: 0xFFFFFFFF,
        reserved1: 0xFFFFFFFF,
        reserved2: 0xFFFFFFFF,
        reserved3: 0xFFFFFFFF,
        pages: pages,
    };

    return samplePack;
}