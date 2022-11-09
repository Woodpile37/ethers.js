"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeBase58 = exports.encodeBase58 = void 0;
const data_js_1 = require("./data.js");
const errors_js_1 = require("./errors.js");
const maths_js_1 = require("./maths.js");
const Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let Lookup = null;
function getAlpha(letter) {
    if (Lookup == null) {
        Lookup = {};
        for (let i = 0; i < Alphabet.length; i++) {
            Lookup[Alphabet[i]] = BigInt(i);
        }
    }
    const result = Lookup[letter];
    (0, errors_js_1.assertArgument)(result != null, `invalid base58 value`, "letter", letter);
    return result;
}
const BN_0 = BigInt(0);
const BN_58 = BigInt(58);
/**
 *  Encode %%value%% as Base58-encoded data.
 */
function encodeBase58(_value) {
    let value = (0, maths_js_1.toBigInt)((0, data_js_1.getBytes)(_value));
    let result = "";
    while (value) {
        result = Alphabet[Number(value % BN_58)] + result;
        value /= BN_58;
    }
    return result;
}
exports.encodeBase58 = encodeBase58;
/**
 *  Decode the Base58-encoded %%value%%.
 */
function decodeBase58(value) {
    let result = BN_0;
    for (let i = 0; i < value.length; i++) {
        result *= BN_58;
        result += getAlpha(value[i]);
    }
    return (0, data_js_1.getBytes)((0, maths_js_1.toHex)(result));
}
exports.decodeBase58 = decodeBase58;
//# sourceMappingURL=base58.js.map