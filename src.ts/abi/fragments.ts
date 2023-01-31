/**
 *  About frgaments...
 *
 *  @_subsection api/abi/abi-coder:Fragments
 */

import {
    defineProperties, getBigInt, getNumber,
    assert, assertPrivate, assertArgument
} from "../utils/index.js";
import { id } from "../hash/index.js";

/**
 *  A type description in a JSON API.
 */
export interface JsonFragmentType {
    /**
     *  The parameter name.
     */
    readonly name?: string;

    /**
     *  If the parameter is indexed.
     */
    readonly indexed?: boolean;

    /**
     *  The type of the parameter.
     */
    readonly type?: string;

    /**
     *  The internal Solidity type.
     */
    readonly internalType?: string;

    /**
     *  The components for a tuple.
     */
    readonly components?: ReadonlyArray<JsonFragmentType>;
}

/**
 *  A fragment for a method, event or error in a JSON API.
 */
export interface JsonFragment {
    /**
     *  The name of the error, event, function, etc.
     */
    readonly name?: string;

    /**
     *  The type of the fragment (e.g. ``event``, ``"function"``, etc.)
     */
    readonly type?: string;

    /**
     *  If the event is anonymous.
     */
    readonly anonymous?: boolean;

    /**
     *  If the function is payable.
     */
    readonly payable?: boolean;

    /**
     *  If the function is constant.
     */
    readonly constant?: boolean;

    /**
     *  The mutability state of the function.
     */
    readonly stateMutability?: string;

    /**
     *  The input parameters.
     */
    readonly inputs?: ReadonlyArray<JsonFragmentType>;

    /**
     *  The output parameters.
     */
    readonly outputs?: ReadonlyArray<JsonFragmentType>;

    /**
     *  The gas limit to use when sending a transaction for this function.
     */
    readonly gas?: string;
};

/**
 *  The format to serialize the output as.
 */
export type FormatType =
    // Bare formatting, as is needed for computing a sighash of an event or function
    "sighash" |

    // Human-Readable with Minimal spacing and without names (compact human-readable)
    "minimal" |

    // Human-Readable with nice spacing, including all names
    "full" |

    // JSON-format a la Solidity
    "json";

// [ "a", "b" ] => { "a": 1, "b": 1 }
function setify(items: Array<string>): ReadonlySet<string> {
    const result: Set<string> = new Set();
    items.forEach((k) => result.add(k));
    return Object.freeze(result);
}

// Visibility Keywords
const _kwVisib = "constant external internal payable private public pure view";
const KwVisib = setify(_kwVisib.split(" "));

const _kwTypes = "constructor error event fallback function receive struct";
const KwTypes = setify(_kwTypes.split(" "));

const _kwModifiers = "calldata memory storage payable indexed";
const KwModifiers = setify(_kwModifiers.split(" "));

const _kwOther = "tuple returns";

// All Keywords
const _keywords = [ _kwTypes, _kwModifiers, _kwOther, _kwVisib ].join(" ");
const Keywords = setify(_keywords.split(" "));

// Single character tokens
const SimpleTokens: Record<string, string> = {
  "(": "OPEN_PAREN", ")": "CLOSE_PAREN",
  "[": "OPEN_BRACKET", "]": "CLOSE_BRACKET",
  ",": "COMMA", "@": "AT"
};

// Parser regexes to consume the next token
const regexWhitespace = new RegExp("^(\\s*)");
const regexNumber = new RegExp("^([0-9]+)");
const regexIdentifier = new RegExp("^([a-zA-Z$_][a-zA-Z0-9$_]*)");
const regexType = new RegExp("^(address|bool|bytes([0-9]*)|string|u?int([0-9]*))");

/**
 *  @ignore:
 */
type Token = Readonly<{
    // Type of token (e.g. TYPE, KEYWORD, NUMBER, etc)
    type: string;

    // Offset into the original source code
    offset: number;

    // Actual text content of the token
    text: string;

    // The parenthesis depth
    depth: number;

    // If a parenthesis, the offset (in tokens) that balances it
    match: number;

    // For parenthesis and commas, the offset (in tokens) to the
    // previous/next parenthesis or comma in the list
    linkBack: number;
    linkNext: number;

    // If a BRACKET, the value inside
    value: number;
}>;

class TokenString {
    #offset: number;
    #tokens: ReadonlyArray<Token>;

    get offset(): number { return this.#offset; }
    get length(): number { return this.#tokens.length - this.#offset; }

    constructor(tokens: ReadonlyArray<Token>) {
        this.#offset = 0;
        this.#tokens = tokens.slice();
    }

    clone(): TokenString { return new TokenString(this.#tokens); }
    reset(): void { this.#offset = 0; }

    #subTokenString(from: number = 0, to: number = 0): TokenString {
        return new TokenString(this.#tokens.slice(from, to).map((t) => {
            return Object.freeze(Object.assign({ }, t, {
                match: (t.match - from),
                linkBack: (t.linkBack - from),
                linkNext: (t.linkNext - from),
            }));
            return t;
        }));
    }

    // Pops and returns the value of the next token, if it is a keyword in allowed; throws if out of tokens
    popKeyword(allowed: ReadonlySet<string>): string {
        const top = this.peek();
        if (top.type !== "KEYWORD" || !allowed.has(top.text)) { throw new Error(`expected keyword ${ top.text }`); }
        return this.pop().text;
    }

    // Pops and returns the value of the next token if it is `type`; throws if out of tokens
    popType(type: string): string {
        if (this.peek().type !== type) { throw new Error(`expected ${ type }; got ${ JSON.stringify(this.peek()) }`); }
        return this.pop().text;
    }

    // Pops and returns a "(" TOKENS ")"
    popParen(): TokenString {
        const top = this.peek();
        if (top.type !== "OPEN_PAREN") { throw new Error("bad start"); }
        const result = this.#subTokenString(this.#offset + 1, top.match + 1);
        this.#offset = top.match + 1;
        return result;
    }

    // Pops and returns the items within "(" ITEM1 "," ITEM2 "," ... ")"
    popParams(): Array<TokenString> {
        const top = this.peek();

        if (top.type !== "OPEN_PAREN") { throw new Error("bad start"); }

        const result: Array<TokenString> = [ ];

        while(this.#offset < top.match - 1) {
            const link = this.peek().linkNext;
            result.push(this.#subTokenString(this.#offset + 1, link));
            this.#offset = link;
        }

        this.#offset = top.match + 1;

        return result;
    }

    // Returns the top Token, throwing if out of tokens
    peek(): Token {
        if (this.#offset >= this.#tokens.length) {
            throw new Error("out-of-bounds");
        }
        return this.#tokens[this.#offset];
    }

    // Returns the next value, if it is a keyword in `allowed`
    peekKeyword(allowed: ReadonlySet<string>): null | string {
        const top = this.peekType("KEYWORD");
        return (top != null && allowed.has(top)) ? top: null;
    }

    // Returns the value of the next token if it is `type`
    peekType(type: string): null | string {
        if (this.length === 0) { return null; }
        const top = this.peek();
        return (top.type === type) ? top.text: null;
    }

    // Returns the next token; throws if out of tokens
    pop(): Token {
        const result = this.peek();
        this.#offset++;
        return result;
    }

    toString(): string {
        const tokens: Array<string> = [ ];
        for (let i = this.#offset; i < this.#tokens.length; i++) {
            const token = this.#tokens[i];
            tokens.push(`${ token.type }:${ token.text }`);
        }
        return `<TokenString ${ tokens.join(" ") }>`
    }
}

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

function lex(text: string): TokenString {
    const tokens: Array<Token> = [ ];

    const throwError = (message: string) => {
        const token = (offset < text.length) ? JSON.stringify(text[offset]): "$EOI";
        throw new Error(`invalid token ${ token } at ${ offset }: ${ message }`);
    };

    let brackets: Array<number> = [ ];
    let commas: Array<number> = [ ];

    let offset = 0;
    while (offset < text.length) {

        // Strip off any leading whitespace
        let cur = text.substring(offset);
        let match = cur.match(regexWhitespace);
        if (match) {
            offset += match[1].length;
            cur = text.substring(offset);
        }

        const token = { depth: brackets.length, linkBack: -1, linkNext: -1, match: -1, type: "", text: "", offset, value: -1 };
        tokens.push(token);

        let type = (SimpleTokens[cur[0]] || "");
        if (type) {
            token.type = type;
            token.text = cur[0];
            offset++;

            if (type === "OPEN_PAREN") {
                brackets.push(tokens.length - 1);
                commas.push(tokens.length - 1);

            } else if (type == "CLOSE_PAREN") {
                if (brackets.length === 0) { throwError("no matching open bracket"); }

                token.match = brackets.pop() as number;
                (<Writeable<Token>>(tokens[token.match])).match = tokens.length - 1;
                token.depth--;

                token.linkBack = commas.pop() as number;
                (<Writeable<Token>>(tokens[token.linkBack])).linkNext = tokens.length - 1;

            } else if (type === "COMMA") {
                token.linkBack = commas.pop() as number;
                (<Writeable<Token>>(tokens[token.linkBack])).linkNext = tokens.length - 1;
                commas.push(tokens.length - 1);

            } else if (type === "OPEN_BRACKET") {
                token.type = "BRACKET";

            } else if (type === "CLOSE_BRACKET") {
                // Remove the CLOSE_BRACKET
                let suffix = (tokens.pop() as Token).text;
                if (tokens.length > 0 && tokens[tokens.length - 1].type === "NUMBER") {
                    const value = (tokens.pop() as Token).text;
                    suffix = value + suffix;
                    (<Writeable<Token>>(tokens[tokens.length - 1])).value = getNumber(value);
                }
                if (tokens.length === 0 || tokens[tokens.length - 1].type !== "BRACKET") {
                    throw new Error("missing opening bracket");
                }
                (<Writeable<Token>>(tokens[tokens.length - 1])).text += suffix;
            }

            continue;
        }

        match = cur.match(regexIdentifier);
        if (match) {
            token.text = match[1];
            offset += token.text.length;

            if (Keywords.has(token.text)) {
                token.type = "KEYWORD";
                continue;
            }

            if (token.text.match(regexType)) {
                token.type = "TYPE";
                continue;
            }

            token.type = "ID";
            continue;
        }

        match = cur.match(regexNumber);
        if (match) {
            token.text = match[1];
            token.type = "NUMBER";
            offset += token.text.length;
            continue;
        }

        throw new Error(`unexpected token ${ JSON.stringify(cur[0]) } at position ${ offset }`);
    }

    return new TokenString(tokens.map((t) => Object.freeze(t)));
}

// Check only one of `allowed` is in `set`
function allowSingle(set: ReadonlySet<string>, allowed: ReadonlySet<string>): void {
    let included: Array<string> = [ ];
    for (const key in allowed.keys()) {
        if (set.has(key)) { included.push(key); }
    }
    if (included.length > 1) { throw new Error(`conflicting types: ${ included.join(", ") }`); }
}

// Functions to process a Solidity Signature TokenString from left-to-right for...

// ...the name with an optional type, returning the name
function consumeName(type: string, tokens: TokenString): string {
    if (tokens.peekKeyword(KwTypes)) {
        const keyword = tokens.pop().text;
        if (keyword !== type) {
            throw new Error(`expected ${ type }, got ${ keyword }`);
        }
    }

    return tokens.popType("ID");
}

// ...all keywords matching allowed, returning the keywords
function consumeKeywords(tokens: TokenString, allowed?: ReadonlySet<string>): ReadonlySet<string> {
    const keywords: Set<string> = new Set();
    while (true) {
        const keyword = tokens.peekType("KEYWORD");

        if (keyword == null || (allowed && !allowed.has(keyword))) { break; }
        tokens.pop();

        if (keywords.has(keyword)) { throw new Error(`duplicate keywords: ${ JSON.stringify(keyword) }`); }
        keywords.add(keyword);
    }

    return Object.freeze(keywords);
}

// ...all visibility keywords, returning the coalesced mutability
function consumeMutability(tokens: TokenString): "payable" | "nonpayable" | "view" | "pure" {
    let modifiers = consumeKeywords(tokens, KwVisib);

    // Detect conflicting modifiers
    allowSingle(modifiers, setify("constant payable nonpayable".split(" ")));
    allowSingle(modifiers, setify("pure view payable nonpayable".split(" ")));

    // Process mutability states
    if (modifiers.has("view")) { return "view"; }
    if (modifiers.has("pure")) { return "pure"; }
    if (modifiers.has("payable")) { return "payable"; }
    if (modifiers.has("nonpayable")) { return "nonpayable"; }

    // Process legacy `constant` last
    if (modifiers.has("constant")) { return "view"; }

    return "nonpayable";
}

// ...a parameter list, returning the ParamType list
function consumeParams(tokens: TokenString, allowIndexed?: boolean): Array<ParamType> {
    return tokens.popParams().map((t) => ParamType.from(t, allowIndexed));
}

// ...a gas limit, returning a BigNumber or null if none
function consumeGas(tokens: TokenString): null | bigint {
    if (tokens.peekType("AT")) {
        tokens.pop();
        if (tokens.peekType("NUMBER")) {
            return getBigInt(tokens.pop().text);
        }
        throw new Error("invalid gas");
    }
    return null;
}

function consumeEoi(tokens: TokenString): void {
    if (tokens.length) {
        throw new Error(`unexpected tokens: ${ tokens.toString() }`);
    }
}

const regexArrayType = new RegExp(/^(.*)\[([0-9]*)\]$/);

function verifyBasicType(type: string): string {
    const match = type.match(regexType);
    assertArgument(match, "invalid type", "type", type);
    if (type === "uint") { return "uint256"; }
    if (type === "int") { return "int256"; }

    if (match[2]) {
        // bytesXX
        const length = parseInt(match[2]);
        assertArgument(length !== 0 && length <= 32, "invalid bytes length", "type", type);

    } else if (match[3]) {
        // intXX or uintXX
        const size = parseInt(match[3] as string);
        assertArgument(size !== 0 && size <= 256 && (size % 8) === 0, "invalid numeric width", "type", type);
    }

    return type;
}

// Make the Fragment constructors effectively private
const _guard = { };


/**
 *  When [walking](ParamType-walk) a [[ParamType]], this is called
 *  on each component.
 */
export type ParamTypeWalkFunc = (type: string, value: any) => any;

/**
 *  When [walking asynchronously](ParamType-walkAsync) a [[ParamType]],
 *  this is called on each component.
 */
export type ParamTypeWalkAsyncFunc = (type: string, value: any) => any | Promise<any>;

const internal = Symbol.for("_ethers_internal");

const ParamTypeInternal = "_ParamTypeInternal";
const ErrorFragmentInternal = "_ErrorInternal";
const EventFragmentInternal = "_EventInternal";
const ConstructorFragmentInternal = "_ConstructorInternal";
const FallbackFragmentInternal = "_FallbackInternal";
const FunctionFragmentInternal = "_FunctionInternal";
const StructFragmentInternal = "_StructInternal";

/**
 *  Each input and output of a [[Fragment]] is an Array of **PAramType**.
 */
export class ParamType {

    /**
     *  The local name of the parameter (or ``""`` if unbound)
     */
    readonly name!: string;

    /**
     *  The fully qualified type (e.g. ``"address"``, ``"tuple(address)"``,
     *  ``"uint256[3][]"``)
     */
    readonly type!: string;

    /**
     *  The base type (e.g. ``"address"``, ``"tuple"``, ``"array"``)
     */
    readonly baseType!: string;

    /**
     *  True if the parameters is indexed.
     *
     *  For non-indexable types (see [[ParamType_isIndexable]]) this
     *  is ``null``.
     */
    readonly indexed!: null | boolean;

    /**
     *  The components for the tuple.
     *
     *  For non-tuple types (see [[ParamType_isTuple]]) this is ``null``.
     */
    readonly components!: null | ReadonlyArray<ParamType>;

    /**
     *  The array length, or ``-1`` for dynamic-lengthed arrays.
     *
     *  For non-array types (see [[ParamType_isArray]]) this is ``null``.
     */
    readonly arrayLength!: null | number;

    /**
     *  The type of each child in the array.
     *
     *  For non-array types (see [[ParamType_isArray]]) this is ``null``.
     */
    readonly arrayChildren!: null | ParamType;


    /**
     *  @private
     */
    constructor(guard: any, name: string, type: string, baseType: string, indexed: null | boolean, components: null | ReadonlyArray<ParamType>, arrayLength: null | number, arrayChildren: null | ParamType) {
        assertPrivate(guard, _guard, "ParamType");
        Object.defineProperty(this, internal, { value: ParamTypeInternal });

        if (components) { components = Object.freeze(components.slice()); }

        if (baseType === "array") {
            if (arrayLength == null || arrayChildren == null) {
                throw new Error("");
            }
        } else if (arrayLength != null || arrayChildren != null) {
            throw new Error("");
        }

        if (baseType === "tuple") {
            if (components == null) { throw new Error(""); }
        } else if (components != null) {
            throw new Error("");
        }

        defineProperties<ParamType>(this, {
            name, type, baseType, indexed, components, arrayLength, arrayChildren
        });
    }

    /**
     *  Return a string representation of this type.
     *
     *  For example,
     *
     *  ``sighash" => "(uint256,address)"``
     *
     *  ``"minimal" => "tuple(uint256,address) indexed"``
     *
     *  ``"full" => "tuple(uint256 foo, address bar) indexed baz"``
     */
    format(format?: FormatType): string {
        if (format == null) { format = "sighash"; }
        if (format === "json") {
            let result: any = {
                type: ((this.baseType === "tuple") ? "tuple": this.type),
                name: (this.name || undefined)
            };
            if (typeof(this.indexed) === "boolean") { result.indexed = this.indexed; }
            if (this.isTuple()) {
                result.components = this.components.map((c) => JSON.parse(c.format(format)));
            }
            return JSON.stringify(result);
        }

        let result = "";

        // Array
        if (this.isArray()) {
            result += this.arrayChildren.format(format);
            result += `[${ (this.arrayLength < 0 ? "": String(this.arrayLength)) }]`;
        } else {
            if (this.isTuple()) {
                if (format !== "sighash") { result += this.type; }
                result += "(" + this.components.map(
                    (comp) => comp.format(format)
                ).join((format === "full") ? ", ": ",") + ")";
            } else {
                result += this.type;
            }
        }

        if (format !== "sighash") {
            if (this.indexed === true) { result += " indexed"; }
            if (format === "full" && this.name) {
                result += " " + this.name;
            }
        }

        return result;
    }

    /*
     *  Returns true if %%value%% is an Array type.
     *
     *  This provides a type gaurd ensuring that the
     *  [[arrayChildren]] and [[arrayLength]] are non-null.
     */
    //static isArray(value: any): value is { arrayChildren: ParamType, arrayLength: number } {
    //    return value && (value.baseType === "array")
    //}

    /**
     *  Returns true if %%this%% is an Array type.
     *
     *  This provides a type gaurd ensuring that [[arrayChildren]]
     *  and [[arrayLength]] are non-null.
     */
    isArray(): this is (ParamType & { arrayChildren: ParamType, arrayLength: number }) {
        return (this.baseType === "array")
    }

    /**
     *  Returns true if %%this%% is a Tuple type.
     *
     *  This provides a type gaurd ensuring that [[components]]
     *  is non-null.
     */
    isTuple(): this is (ParamType & { components: ReadonlyArray<ParamType> }) {
        return (this.baseType === "tuple");
    }

    /**
     *  Returns true if %%this%% is an Indexable type.
     *
     *  This provides a type gaurd ensuring that [[indexed]]
     *  is non-null.
     */
    isIndexable(): this is (ParamType & { indexed: boolean }) {
        return (this.indexed != null);
    }

    /**
     *  Walks the **ParamType** with %%value%%, calling %%process%%
     *  on each type, destructing the %%value%% recursively.
     */
    walk(value: any, process: ParamTypeWalkFunc): any {
        if (this.isArray()) {
            if (!Array.isArray(value)) { throw new Error("invlaid array value"); }
            if (this.arrayLength !== -1 && value.length !== this.arrayLength) {
                throw new Error("array is wrong length");
            }
            const _this = this;
            return value.map((v) => (_this.arrayChildren.walk(v, process)));
        }

        if (this.isTuple()) {
            if (!Array.isArray(value)) { throw new Error("invlaid tuple value"); }
            if (value.length !== this.components.length) {
                throw new Error("array is wrong length");
            }
            const _this = this;
            return value.map((v, i) => (_this.components[i].walk(v, process)));
        }

        return process(this.type, value);
    }

    #walkAsync(promises: Array<Promise<void>>, value: any, process: ParamTypeWalkAsyncFunc, setValue: (value: any) => void): void {

        if (this.isArray()) {
            if (!Array.isArray(value)) { throw new Error("invlaid array value"); }
            if (this.arrayLength !== -1 && value.length !== this.arrayLength) {
                throw new Error("array is wrong length");
            }
            const childType = this.arrayChildren;

            const result = value.slice();
            result.forEach((value, index) => {
                childType.#walkAsync(promises, value, process, (value: any) => {
                    result[index] = value;
                });
            });
            setValue(result);
            return;
        }

        if (this.isTuple()) {
            const components = this.components;

            // Convert the object into an array
            let result: Array<any>;
            if (Array.isArray(value)) {
                result = value.slice();

            } else {
                if (value == null || typeof(value) !== "object") {
                    throw new Error("invlaid tuple value");
                }

                result = components.map((param) => {
                    if (!param.name) { throw new Error("cannot use object value with unnamed components"); }
                    if (!(param.name in value)) {
                        throw new Error(`missing value for component ${ param.name }`);
                    }
                    return value[param.name];
                });
            }

            if (result.length !== this.components.length) {
                throw new Error("array is wrong length");
            }

            result.forEach((value, index) => {
                components[index].#walkAsync(promises, value, process, (value: any) => {
                    result[index] = value;
                });
            });
            setValue(result);
            return;
        }

        const result = process(this.type, value);
        if (result.then) {
            promises.push((async function() { setValue(await result); })());
        } else {
            setValue(result);
        }
    }

    /**
     *  Walks the **ParamType** with %%value%%, asynchronously calling
     *  %%process%% on each type, destructing the %%value%% recursively.
     *
     *  This can be used to resolve ENS naes by walking and resolving each
     *  ``"address"`` type.
     */
    async walkAsync(value: any, process: ParamTypeWalkAsyncFunc): Promise<any> {
        const promises: Array<Promise<void>> = [ ];
        const result: [ any ] = [ value ];
        this.#walkAsync(promises, value, process, (value: any) => {
            result[0] = value;
        });
        if (promises.length) { await Promise.all(promises); }
        return result[0];
    }

    /**
     *  Creates a new **ParamType** for %%obj%%.
     *
     *  If %%allowIndexed%% then the ``indexed`` keyword is permitted,
     *  otherwise the ``indexed`` keyword will throw an error.
     */
    static from(obj: any, allowIndexed?: boolean): ParamType {
        if (ParamType.isParamType(obj)) { return obj; }

        if (typeof(obj) === "string") {
            return ParamType.from(lex(obj), allowIndexed);

        } else if (obj instanceof TokenString) {
            let type = "", baseType = "";
            let comps: null | Array<ParamType> = null;

            if (consumeKeywords(obj, setify([ "tuple" ])).has("tuple") || obj.peekType("OPEN_PAREN")) {
                // Tuple
                baseType = "tuple";
                comps = obj.popParams().map((t) => ParamType.from(t));
                type = `tuple(${ comps.map((c) => c.format()).join(",") })`;
            } else {
                // Normal
                type = verifyBasicType(obj.popType("TYPE"));
                baseType = type;
            }

            // Check for Array
            let arrayChildren: null | ParamType  = null;
            let arrayLength: null | number = null;

            while (obj.length && obj.peekType("BRACKET")) {
                const bracket = obj.pop(); //arrays[i];
                arrayChildren = new ParamType(_guard, "", type, baseType, null, comps, arrayLength, arrayChildren);
                arrayLength = bracket.value;
                type += bracket.text;
                baseType = "array";
                comps = null;
            }

            let indexed = null;
            const keywords = consumeKeywords(obj, KwModifiers);
            if (keywords.has("indexed")) {
                if (!allowIndexed) { throw new Error(""); }
                indexed = true;
            }

            const name = (obj.peekType("ID") ? obj.pop().text: "");

            if (obj.length) { throw new Error("leftover tokens"); }

            return new ParamType(_guard, name, type, baseType, indexed, comps, arrayLength, arrayChildren);
        }

        const name = obj.name;
        assertArgument(!name || (typeof(name) === "string" && name.match(regexIdentifier)),
            "invalid name", "obj.name", name);

        let indexed = obj.indexed;
        if (indexed != null) {
            assertArgument(allowIndexed, "parameter cannot be indexed", "obj.indexed", obj.indexed);
            indexed = !!indexed;
        }

        let type = obj.type;

        let arrayMatch = type.match(regexArrayType);
        if (arrayMatch) {
            const arrayLength = parseInt(arrayMatch[2] || "-1");
            const arrayChildren = ParamType.from({
                type: arrayMatch[1],
                components: obj.components
            });

            return new ParamType(_guard, name || "", type, "array", indexed, null, arrayLength, arrayChildren);
        }

        if (type === "tuple" || type.substring(0, 5) === "tuple(" || type[0] === "(") {
            const comps = (obj.components != null) ? obj.components.map((c: any) => ParamType.from(c)): null;
            const tuple = new ParamType(_guard, name || "", type, "tuple", indexed, comps, null, null);
            // @TODO: use lexer to validate and normalize type
            return tuple;
        }

        type = verifyBasicType(obj.type);

        return new ParamType(_guard, name || "", type, type, indexed, null, null, null);
    }

    /**
     *  Returns true if %%value%% is a **ParamType**.
     */
    static isParamType(value: any): value is ParamType {
        return (value && value[internal] === ParamTypeInternal);
    }
}

/**
 *  The type of a [[Fragment]].
 */
export type FragmentType = "constructor" | "error" | "event" | "fallback" | "function" | "struct";

/**
 *  An abstract class to represent An individual fragment from a parse ABI.
 */
export abstract class Fragment {
    /**
     *  The type of the fragment.
     */
    readonly type!: FragmentType;

    /**
     *  The inputs for the fragment.
     */
    readonly inputs!: ReadonlyArray<ParamType>;

    /**
     *  @private
     */
    constructor(guard: any, type: FragmentType, inputs: ReadonlyArray<ParamType>) {
        assertPrivate(guard, _guard, "Fragment");
        inputs = Object.freeze(inputs.slice());
        defineProperties<Fragment>(this, { type, inputs });
    }

    /**
     *  Returns a string representation of this fragment.
     */
    abstract format(format?: FormatType): string;

    /**
     *  Creates a new **Fragment** for %%obj%%, wich can be any supported
     *  ABI frgament type.
     */
    static from(obj: any): Fragment {
        if (typeof(obj) === "string") {

            // Try parsing JSON...
            try {
                Fragment.from(JSON.parse(obj));
            } catch (e) { }

            // ...otherwise, use the human-readable lexer
            return Fragment.from(lex(obj));
        }

        if (obj instanceof TokenString) {
            // Human-readable ABI (already lexed)

            const type = obj.peekKeyword(KwTypes);

            switch (type) {
                case "constructor": return ConstructorFragment.from(obj);
                case "error": return ErrorFragment.from(obj);
                case "event": return EventFragment.from(obj);
                case "fallback": case "receive":
                    return FallbackFragment.from(obj);
                case "function": return FunctionFragment.from(obj);
                case "struct": return StructFragment.from(obj);
            }

        } else if (typeof(obj) === "object") {
            // JSON ABI

            switch (obj.type) {
                case "constructor": return ConstructorFragment.from(obj);
                case "error": return ErrorFragment.from(obj);
                case "event": return EventFragment.from(obj);
                case "fallback": case "receive":
                    return FallbackFragment.from(obj);
                case "function": return FunctionFragment.from(obj);
                case "struct": return StructFragment.from(obj);
            }

            assert(false, `unsupported type: ${ obj.type }`, "UNSUPPORTED_OPERATION", {
                operation: "Fragment.from"
            });
        }

        assertArgument(false, "unsupported frgament object", "obj", obj);
    }

    /**
     *  Returns true if %%value%% is a [[ConstructorFragment]].
     */
    static isConstructor(value: any): value is ConstructorFragment {
        return ConstructorFragment.isFragment(value);
    }

    /**
     *  Returns true if %%value%% is an [[ErrorFragment]].
     */
    static isError(value: any): value is ErrorFragment {
        return ErrorFragment.isFragment(value);
    }

    /**
     *  Returns true if %%value%% is an [[EventFragment]].
     */
    static isEvent(value: any): value is EventFragment {
        return EventFragment.isFragment(value);
    }

    /**
     *  Returns true if %%value%% is a [[FunctionFragment]].
     */
    static isFunction(value: any): value is FunctionFragment {
        return FunctionFragment.isFragment(value);
    }

    /**
     *  Returns true if %%value%% is a [[StructFragment]].
     */
    static isStruct(value: any): value is StructFragment {
        return StructFragment.isFragment(value);
    }
}

/**
 *  An abstract class to represent An individual fragment
 *  which has a name from a parse ABI.
 */
export abstract class NamedFragment extends Fragment {
    /**
     *  The name of the fragment.
     */
    readonly name!: string;

    /**
     *  @private
     */
    constructor(guard: any, type: FragmentType, name: string, inputs: ReadonlyArray<ParamType>) {
        super(guard, type, inputs);
        assertArgument(typeof(name) === "string" && name.match(regexIdentifier),
            "invalid identifier", "name", name);
        inputs = Object.freeze(inputs.slice());
        defineProperties<NamedFragment>(this, { name });
    }
}

function joinParams(format: FormatType, params: ReadonlyArray<ParamType>): string { 
    return "(" + params.map((p) => p.format(format)).join((format === "full") ? ", ": ",") + ")";
}

/**
 *  A Fragment which represents a //Custom Error//.
 */
export class ErrorFragment extends NamedFragment {
    /**
     *  @private
     */
    constructor(guard: any, name: string, inputs: ReadonlyArray<ParamType>) {
        super(guard, "error", name, inputs);
        Object.defineProperty(this, internal, { value: ErrorFragmentInternal });
    }

    /**
     *  The Custom Error selector.
     */
    get selector(): string {
        return id(this.format("sighash")).substring(0, 10);
    }

    format(format?: FormatType): string {
        if (format == null) { format = "sighash"; }
        if (format === "json") {
            return JSON.stringify({
                type: "error",
                name: this.name,
                inputs: this.inputs.map((input) => JSON.parse(input.format(format))),
            });
        }

        const result = [ ];
        if (format !== "sighash") { result.push("error"); }
        result.push(this.name + joinParams(format, this.inputs));
        return result.join(" ");
    }

    static from(obj: any): ErrorFragment {
        if (ErrorFragment.isFragment(obj)) { return obj; }

        if (typeof(obj) === "string") {
            return ErrorFragment.from(lex(obj));

        } else if (obj instanceof TokenString) {
            const name = consumeName("error", obj);
            const inputs = consumeParams(obj);
            consumeEoi(obj);

            return new ErrorFragment(_guard, name, inputs);
        }

        return new ErrorFragment(_guard, obj.name,
            obj.inputs ? obj.inputs.map(ParamType.from): [ ]);
    }

    static isFragment(value: any): value is ErrorFragment {
        return (value && value[internal] === ErrorFragmentInternal);
    }
}

/**
 *  A Fragment which represents an Event.
 */
export class EventFragment extends NamedFragment {
    readonly anonymous!: boolean;

    /**
     *  @private
     */
    constructor(guard: any, name: string, inputs: ReadonlyArray<ParamType>, anonymous: boolean) {
        super(guard, "event", name, inputs);
        Object.defineProperty(this, internal, { value: EventFragmentInternal });
        defineProperties<EventFragment>(this, { anonymous });
    }

    /**
     *  The Event topic hash.
     */
    get topicHash(): string {
        return id(this.format("sighash"));
    }

    format(format?: FormatType): string {
        if (format == null) { format = "sighash"; }
        if (format === "json") {
            return JSON.stringify({
                type: "event",
                anonymous: this.anonymous,
                name: this.name,
                inputs: this.inputs.map((i) => JSON.parse(i.format(format)))
            });
        }

        const result = [ ];
        if (format !== "sighash") { result.push("event"); }
        result.push(this.name + joinParams(format, this.inputs));
        if (format !== "sighash" && this.anonymous) { result.push("anonymous"); }
        return result.join(" ");
    }

    static from(obj: any): EventFragment {
        if (EventFragment.isFragment(obj)) { return obj; }

        if (typeof(obj) === "string") {
            return EventFragment.from(lex(obj));

        } else if (obj instanceof TokenString) {
            const name = consumeName("event", obj);
            const inputs = consumeParams(obj, true);
            const anonymous = !!consumeKeywords(obj, setify([ "anonymous" ])).has("anonymous");
            consumeEoi(obj);

            return new EventFragment(_guard, name, inputs, anonymous);
        }

        return new EventFragment(_guard, obj.name,
            obj.inputs ? obj.inputs.map((p: any) => ParamType.from(p, true)): [ ], !!obj.anonymous);
    }

    static isFragment(value: any): value is EventFragment {
        return (value && value[internal] === EventFragmentInternal);
    }
}

/**
 *  A Fragment which represents a constructor.
 */
export class ConstructorFragment extends Fragment {
    readonly payable!: boolean;
    readonly gas!: null | bigint;

    /**
     *  @private
     */
    constructor(guard: any, type: FragmentType, inputs: ReadonlyArray<ParamType>, payable: boolean, gas: null | bigint) {
        super(guard, type, inputs);
        Object.defineProperty(this, internal, { value: ConstructorFragmentInternal });
        defineProperties<ConstructorFragment>(this, { payable, gas });
    }

    format(format?: FormatType): string {
        assert(format != null && format !== "sighash", "cannot format a constructor for sighash",
            "UNSUPPORTED_OPERATION", { operation: "format(sighash)" });

        if (format === "json") {
            return JSON.stringify({
                type: "constructor",
                stateMutability: (this.payable ? "payable": "undefined"),
                payable: this.payable,
                gas: ((this.gas != null) ? this.gas: undefined),
                inputs: this.inputs.map((i) => JSON.parse(i.format(format)))
            });
        }

        const result = [ `constructor${ joinParams(format, this.inputs) }` ];
        result.push((this.payable) ? "payable": "nonpayable");
        if (this.gas != null) { result.push(`@${ this.gas.toString() }`); }
        return result.join(" ");
    }

    static from(obj: any): ConstructorFragment {
        if (ConstructorFragment.isFragment(obj)) { return obj; }

        if (typeof(obj) === "string") {
            return ConstructorFragment.from(lex(obj));

        } else if (obj instanceof TokenString) {
            consumeKeywords(obj, setify([ "constructor" ]));
            const inputs = consumeParams(obj);
            const payable = !!consumeKeywords(obj, setify([ "payable" ])).has("payable");
            const gas = consumeGas(obj);
            consumeEoi(obj);

            return new ConstructorFragment(_guard, "constructor", inputs, payable, gas);
        }

        return new ConstructorFragment(_guard, "constructor",
            obj.inputs ? obj.inputs.map(ParamType.from): [ ],
            !!obj.payable, (obj.gas != null) ? obj.gas: null);
    }

    static isFragment(value: any): value is ConstructorFragment {
        return (value && value[internal] === ConstructorFragmentInternal);
    }
}

/**
 *  A Fragment which represents a method.
 */
export class FallbackFragment extends Fragment {

    /**
     *  If the function can be sent value during invocation.
     */
    readonly payable!: boolean;

    constructor(guard: any, inputs: ReadonlyArray<ParamType>, payable: boolean) {
        super(guard, "fallback", inputs);
        Object.defineProperty(this, internal, { value: FallbackFragmentInternal });
        defineProperties<FallbackFragment>(this, { payable });
    }

    format(format?: FormatType): string {
        const type = ((this.inputs.length === 0) ? "receive": "fallback");

        if (format === "json") {
            const stateMutability = (this.payable ? "payable": "nonpayable");
            return JSON.stringify({ type, stateMutability });
        }

        return `${ type }()${ this.payable ? " payable": "" }`;
    }

    static from(obj: any): FallbackFragment {
        if (FallbackFragment.isFragment(obj)) { return obj; }

        if (typeof(obj) === "string") {
             return FallbackFragment.from(lex(obj));

        } else if (obj instanceof TokenString) {
            const errorObj = obj.toString();

            const topIsValid = obj.peekKeyword(setify([ "fallback", "receive" ]));
            assertArgument(topIsValid, "type must be fallback or receive", "obj", errorObj);

            const type = obj.popKeyword(setify([ "fallback", "receive" ]));

            // receive()
            if (type === "receive") {
                const inputs = consumeParams(obj);
                assertArgument(inputs.length === 0, `receive cannot have arguments`, "obj.inputs", inputs);
                consumeKeywords(obj, setify([ "payable" ]));
                consumeEoi(obj);
                return new FallbackFragment(_guard, [ ], true);
            }

            // fallback() [payable]
            // fallback(bytes) [payable] returns (bytes)
            let inputs = consumeParams(obj);
            if (inputs.length) {
                assertArgument(inputs.length === 1 && inputs[0].type === "bytes",
                    "invalid fallback inputs", "obj.inputs",
                    inputs.map((i) => i.format("minimal")).join(", "));
            } else {
                inputs = [ ParamType.from("bytes") ];
            }

            const mutability = consumeMutability(obj);
            assertArgument(mutability === "nonpayable" || mutability === "payable", "fallback cannot be constants", "obj.stateMutability", mutability);

            if (consumeKeywords(obj, setify([ "returns" ])).has("returns")) {
                const outputs = consumeParams(obj);
                assertArgument(outputs.length === 1 && outputs[0].type === "bytes",
                    "invalid fallback outputs", "obj.outputs",
                    outputs.map((i) => i.format("minimal")).join(", "));
            }

            consumeEoi(obj);

            return new FallbackFragment(_guard, inputs, mutability === "payable");
        }

        if (obj.type === "receive") {
            return new FallbackFragment(_guard, [ ], true);
        }

        if (obj.type === "fallback") {
            const inputs = [ ParamType.from("bytes") ];
            const payable = (obj.stateMutability === "payable");
            return new FallbackFragment(_guard, inputs, payable);
        }

        assertArgument(false, "invalid fallback description", "obj", obj);
    }

    static isFragment(value: any): value is FallbackFragment {
        return (value && value[internal] === FallbackFragmentInternal);
    }
}


/**
 *  A Fragment which represents a method.
 */
export class FunctionFragment extends NamedFragment {
    /**
     *  If the function is constant (e.g. ``pure`` or ``view`` functions).
     */
    readonly constant!: boolean;

    /**
     *  The returned types for the result of calling this function.
     */
    readonly outputs!: ReadonlyArray<ParamType>;

    /**
     *  The state mutability (e.g. ``payable``, ``nonpayable``, ``view``
     *  or ``pure``)
     */
    readonly stateMutability!: "payable" | "nonpayable" | "view" | "pure";

    /**
     *  If the function can be sent value during invocation.
     */
    readonly payable!: boolean;

    /**
     *  The amount of gas to send when calling this function
     */
    readonly gas!: null | bigint;

    /**
     *  @private
     */
    constructor(guard: any, name: string, stateMutability: "payable" | "nonpayable" | "view" | "pure", inputs: ReadonlyArray<ParamType>, outputs: ReadonlyArray<ParamType>, gas: null | bigint) {
        super(guard, "function", name, inputs);
        Object.defineProperty(this, internal, { value: FunctionFragmentInternal });
        outputs = Object.freeze(outputs.slice());
        const constant = (stateMutability === "view" || stateMutability === "pure");
        const payable = (stateMutability === "payable");
        defineProperties<FunctionFragment>(this, { constant, gas, outputs, payable, stateMutability });
    }

    /**
     *  The Function selector.
     */
    get selector(): string {
        return id(this.format("sighash")).substring(0, 10);
    }

    format(format?: FormatType): string {
        if (format == null) { format = "sighash"; }
        if (format === "json") {
            return JSON.stringify({
                type: "function",
                name: this.name,
                constant: this.constant,
                stateMutability: ((this.stateMutability !== "nonpayable") ? this.stateMutability: undefined),
                payable: this.payable,
                gas: ((this.gas != null) ? this.gas: undefined),
                inputs: this.inputs.map((i) => JSON.parse(i.format(format))),
                outputs: this.outputs.map((o) => JSON.parse(o.format(format))),
            });
        }

        const result = [];

        if (format !== "sighash") { result.push("function"); }

        result.push(this.name + joinParams(format, this.inputs));

        if (format !== "sighash") {
            if (this.stateMutability !== "nonpayable") {
                result.push(this.stateMutability);
            }

            if (this.outputs && this.outputs.length) {
                result.push("returns");
                result.push(joinParams(format, this.outputs));
            }

            if (this.gas != null) { result.push(`@${ this.gas.toString() }`); }
        }
        return result.join(" ");
    }

    static from(obj: any): FunctionFragment {
        if (FunctionFragment.isFragment(obj)) { return obj; }

        if (typeof(obj) === "string") {
             return FunctionFragment.from(lex(obj));

        } else if (obj instanceof TokenString) {
            const name = consumeName("function", obj);
            const inputs = consumeParams(obj);
            const mutability = consumeMutability(obj);

            let outputs: Array<ParamType> = [ ];
            if (consumeKeywords(obj, setify([ "returns" ])).has("returns")) {
                outputs = consumeParams(obj);
            }

            const gas = consumeGas(obj);

            consumeEoi(obj);

            return new FunctionFragment(_guard, name, mutability, inputs, outputs, gas);
        }

        // @TODO: verifyState for stateMutability

        return new FunctionFragment(_guard, obj.name, obj.stateMutability,
             obj.inputs ? obj.inputs.map(ParamType.from): [ ],
             obj.outputs ? obj.outputs.map(ParamType.from): [ ],
             (obj.gas != null) ? obj.gas: null);
    }

    static isFragment(value: any): value is FunctionFragment {
        return (value && value[internal] === FunctionFragmentInternal);
    }
}

/**
 *  A Fragment which represents a structure.
 */
export class StructFragment extends NamedFragment {

    /**
     *  @private
     */
    constructor(guard: any, name: string, inputs: ReadonlyArray<ParamType>) {
        super(guard, "struct", name, inputs);
        Object.defineProperty(this, internal, { value: StructFragmentInternal });
    }

    format(): string {
        throw new Error("@TODO");
    }

    static from(obj: any): StructFragment {
        if (typeof(obj) === "string") {
            return StructFragment.from(lex(obj));

        } else if (obj instanceof TokenString) {
            const name = consumeName("struct", obj);
            const inputs = consumeParams(obj);
            consumeEoi(obj);
            return new StructFragment(_guard, name, inputs);
        }

        return new StructFragment(_guard, obj.name, obj.inputs ? obj.inputs.map(ParamType.from): [ ]);
    }

    static isFragment(value: any): value is FunctionFragment {
        return (value && value[internal] === StructFragmentInternal);
    }
}

