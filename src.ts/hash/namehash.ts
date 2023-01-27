
import { keccak256 } from "../crypto/index.js";
import {
    concat, hexlify, assertArgument, toUtf8Bytes, toUtf8String
} from "../utils/index.js";


import { ens_normalize } from "@adraffy/ens-normalize";

const Zeros = new Uint8Array(32);
Zeros.fill(0);

function checkComponent(comp: Uint8Array): Uint8Array {
    assertArgument(comp.length !== 0, "invalid ENS name; empty component", "comp", comp)
    return comp;
}

function ensNameSplit(name: string): Array<Uint8Array> {
    const bytes = toUtf8Bytes(ens_normalize(name));
    const comps: Array<Uint8Array> = [ ];

    if (name.length === 0) { return comps; }

    let last = 0;
    for (let i = 0; i < bytes.length; i++) {
        const d = bytes[i];

        // A separator (i.e. "."); copy this component
        if (d === 0x2e) {
            comps.push(checkComponent(bytes.slice(last, i)));
            last = i + 1;
        }
    }

    // There was a stray separator at the end of the name
    assertArgument(last < bytes.length, "invalid ENS name; empty component", "name", name);

    comps.push(checkComponent(bytes.slice(last)));
    return comps;
}

export function ensNormalize(name: string): string {
    return ensNameSplit(name).map((comp) => toUtf8String(comp)).join(".");
}

export function isValidName(name: string): name is string {
    try {
        return (ensNameSplit(name).length !== 0);
    } catch (error) { }
    return false;
}

export function namehash(name: string): string {
    assertArgument(typeof(name) === "string", "invalid ENS name; not a string", "name", name);

    let result: string | Uint8Array = Zeros;

    const comps = ensNameSplit(name);
    while (comps.length) {
        result = keccak256(concat([ result, keccak256(<Uint8Array>(comps.pop()))] ));
    }

    return hexlify(result);
}

export function dnsEncode(name: string): string {
    return hexlify(concat(ensNameSplit(name).map((comp) => {
        // DNS does not allow components over 63 bytes in length
        if (comp.length > 63) {
            throw new Error("invalid DNS encoded entry; length exceeds 63 bytes");
        }

        const bytes = new Uint8Array(comp.length + 1);
        bytes.set(comp, 1);
        bytes[0] = bytes.length - 1;
        return bytes;

    }))) + "00";
}
