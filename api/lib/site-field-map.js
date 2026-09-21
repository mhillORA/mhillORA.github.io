/**
 * Canonical site field mapping for Artemis.
 *
 * Source data is inconsistently shaped per site (legacy promote, survey blobs,
 * city-only "streets", zip stolen from house number, PI baked into name, etc.).
 * Always run records through these helpers before display / prefill / promote.
 *
 * Contract:
 *   name / institution_name  → site label (never an address)
 *   address1 / address2      → kept separate (line 2 = suite/unit as authored)
 *   city / state / zip       → locality parts
 *   address                  → legacy composite; fill gaps only, never over address1
 *   phones                   → NANP 555-555-5555 (optional " x ####")
 */

function trimStr(v) {
    return String(v == null ? '' : v).trim();
}

function normKey(v) {
    return trimStr(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Bare house number mistakenly stored alone in address1 (e.g. "2780", "1201"). */
function looksLikeHouseNumberOnly(v) {
    return /^\d{1,6}[A-Za-z]?$/.test(trimStr(v));
}

/** Unit / suite line that belongs on address2. */
function looksLikeUnitLine(v) {
    return /^(suite|ste\.?|apt\.?|apartment|unit|#|bldg\.?|building|floor|fl\.?)\b/i.test(trimStr(v));
}

/**
 * Detect suite/unit token at a word boundary so "Ste"≠"Stetson", "Fl"≠"Flagler".
 * Group 1 = street remnant, group 2 = unit line.
 */
const EMBEDDED_UNIT_RE =
    /^(.*?)\s*[, ]+\s*((?:suite|ste\.?|apt\.?|apartment|unit|bldg\.?|building|floor|fl\.?|#)\b\s*.+)$/i;

/**
 * If line 1 embeds a suite/unit and line 2 is empty, peel it onto address2.
 * Leaves address1/address2 alone when line 2 is already set.
 */
function splitStreetAndUnit(line1, line2 = '') {
    let a1 = trimStr(line1);
    let a2 = trimStr(line2);
    if (!a1 || a2) return { address1: a1, address2: a2 };
    const m = a1.match(EMBEDDED_UNIT_RE);
    if (m) {
        const street = trimStr(m[1]).replace(/[,\s-]+$/, '');
        const unit = trimStr(m[2]);
        // Need a real street remnant (digits + more than house# + direction alone)
        if (
            street &&
            unit &&
            looksLikeStreet(street) &&
            !/^\d{1,6}[A-Za-z]?\s+[NSEW]$/i.test(street)
        ) {
            return { address1: street, address2: unit };
        }
    }
    return { address1: a1, address2: a2 };
}

function looksLikeStreet(v) {
    const s = trimStr(v);
    if (!s) return false;
    // House number alone is incomplete — not a usable street line
    if (looksLikeHouseNumberOnly(s)) return false;
    if (/\d/.test(s)) return true;
    return /\b(st|street|ave|avenue|rd|road|blvd|drive|dr|ln|lane|way|ct|court|suite|ste|hwy|highway|pkwy|parkway)\b/i.test(
        s
    );
}

/**
 * Normalize US-ish phone to 555-555-5555. Keeps extension as " x 1234".
 * Non-10-digit values are cleaned of Excel junk but otherwise left alone.
 */
function normalizePhone(raw) {
    let s = trimStr(raw);
    if (!s) return '';
    s = s.replace(/_x000[dD]_/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';

    let ext = '';
    const extM = s.match(/(?:ext\.?|extension|x)\s*[:.]?\s*(\d{1,8})\s*$/i);
    if (extM) {
        ext = extM[1];
        s = s.slice(0, extM.index).trim().replace(/[,\s;/-]+$/, '');
    }

    const digits = s.replace(/\D/g, '');
    let d = digits;
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    if (d.length !== 10) {
        const cleaned = trimStr(raw).replace(/_x000[dD]_/gi, '').replace(/\s+/g, ' ').trim();
        return ext && !/\bx\s*\d/i.test(cleaned) ? `${cleaned} x ${ext}` : cleaned;
    }
    const formatted = `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return ext ? `${formatted} x ${ext}` : formatted;
}

/** City-only or non-street placeholder wrongly stored in address1. */
function looksLikeCityOnly(v) {
    const s = trimStr(v);
    if (!s || looksLikeStreet(s) || looksLikeHouseNumberOnly(s)) return false;
    if (s.includes('@')) return false;
    // single/multi-word place name, no digits
    if (/\d/.test(s)) return false;
    if (/^(n\/?a|none|unknown|tbd|test)$/i.test(s)) return false;
    // emails / PI initials mistakenly in address (e.g. "bwatkins")
    if (/^[a-z]+\.[a-z]+$/i.test(s) || (/^[a-z]{2,20}$/i.test(s) && !/^[A-Z][a-z]+(?:\s[A-Z][a-z]+)+$/.test(s))) {
        // bare token like "bwatkins" — not a city
        if (!/^[A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*$/.test(s) && s === s.toLowerCase()) return false;
    }
    return s.length >= 3 && s.length <= 40 && !/,/.test(s);
}

function parseCompositeAddress(blob) {
    const raw = trimStr(blob);
    if (!raw) return { street: '', city: '', state: '', zip: '' };
    const zipM = raw.match(/\b(\d{5}(?:-\d{4})?)\b/);
    const stateM = raw.match(/\b([A-Z]{2})\b(?:\s+\d{5})?\s*$/i) || raw.match(/,\s*([A-Z]{2})\s*(?:,|\d|$)/i);
    let street = raw;
    let city = '';
    let state = stateM ? stateM[1].toUpperCase() : '';
    let zip = zipM ? zipM[1] : '';
    if (stateM) {
        const before = raw.slice(0, stateM.index).replace(/[,\s]+$/, '');
        const parts = before.split(',').map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
            city = parts[parts.length - 1];
            street = parts.slice(0, -1).join(', ');
        } else {
            street = before;
        }
    } else if (raw.includes(',')) {
        const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
        if (
            parts.length >= 2
            && !looksLikeStreet(parts[parts.length - 1])
            && !looksLikeHouseNumberOnly(parts[parts.length - 1])
        ) {
            city = parts[parts.length - 1];
            street = parts.slice(0, -1).join(', ');
        }
    }
    // "1201, Summit Ave" → join house + street when first part is house-number-only
    if (street.includes(',')) {
        const bits = street.split(',').map((p) => p.trim()).filter(Boolean);
        if (bits.length >= 2 && looksLikeHouseNumberOnly(bits[0]) && !looksLikeUnitLine(bits[1])) {
            street = `${bits[0]} ${bits.slice(1).join(', ')}`.replace(/\s+/g, ' ').trim();
        }
    }
    return { street: trimStr(street), city: trimStr(city), state, zip };
}

/**
 * Normalize any site-shaped record into consistent live fields.
 * Safe to call repeatedly; does not mutate input.
 */
function normalizeSiteFields(site) {
    if (!site || typeof site !== 'object') {
        return {
            name: '',
            address1: '',
            address2: '',
            address: '',
            city: '',
            state: '',
            zip: '',
            zipCode: '',
            phone: '',
            piPhone: '',
            siteCoordinatorPhone: '',
            contractsPhone: '',
            pi: '',
            piFirstName: '',
            piLastName: '',
            piEmail: '',
            pi2Name: '',
            pi2Email: '',
            pi3Name: '',
            pi3Email: '',
            siteCoordinator: '',
            siteCoordinatorEmail: '',
        };
    }

    let name = trimStr(site.name || site.institution_name || site.siteName || site.practice_name || '');
    let address1 = trimStr(site.address1 || site.streetAddress || site.street || site.address_street || '');
    let address2 = trimStr(site.address2 || site.streetAddress2 || site.address_line_2 || '');
    // One-time style cleanup: "9001 Wilshire Blvd, Suite 301" → line1 + line2
    ({ address1, address2 } = splitStreetAndUnit(address1, address2));
    let address = trimStr(site.address || site.address_raw || site.mailingAddress || '');
    let city = trimStr(site.city || site.address_city || '');
    let state = trimStr(site.state || site.address_state || '');
    let zip = trimStr(site.zipCode || site.zip || site.postal || site.address_zip || '');
    const piParsed = parsePersonName(site.pi || site.piName || '', {
        firstName: site.piFirstName || site.pi_first_name || '',
        lastName: site.piLastName || site.pi_last_name || '',
    });
    const pi = piParsed.display;
    const piFirstName = piParsed.first;
    const piLastName = piParsed.last;
    const piEmail = trimStr(site.piEmail || '');
    const pi2Parsed = parsePersonName(site.pi2Name || '', {
        firstName: site.pi2FirstName || '',
        lastName: site.pi2LastName || '',
    });
    const pi2Name = pi2Parsed.display;
    const pi2Email = trimStr(site.pi2Email || '');
    const pi3Parsed = parsePersonName(site.pi3Name || '', {
        firstName: site.pi3FirstName || '',
        lastName: site.pi3LastName || '',
    });
    const pi3Name = pi3Parsed.display;
    const pi3Email = trimStr(site.pi3Email || '');

    // City wrongly stored as address1 (e.g. "San Antonio")
    if (address1 && looksLikeCityOnly(address1) && !city) {
        city = address1;
        address1 = '';
    } else if (address1 && looksLikeCityOnly(address1) && city && normKey(address1) === normKey(city)) {
        address1 = '';
    }

    // Prefer real street; fall back to composite `address` only when address1 empty/useless
    // (does NOT merge address2 into address1 — lines stay separate)
    if (!address1 || !looksLikeStreet(address1) || looksLikeHouseNumberOnly(address1)) {
        if (address && (looksLikeStreet(address) || address.includes(',')) && normKey(address) !== normKey(name)) {
            const parsed = parseCompositeAddress(address);
            if (parsed.street && looksLikeStreet(parsed.street)) address1 = parsed.street;
            if (!city && parsed.city) city = parsed.city;
            if (!state && parsed.state) state = parsed.state;
            if (!zip && parsed.zip) zip = parsed.zip;
        }
    }

    // Institution name mistakenly in address fields
    if (name && address1 && normKey(address1) === normKey(name) && !looksLikeStreet(address1)) {
        address1 = '';
    }
    if (name && address1.toLowerCase().startsWith(name.toLowerCase())) {
        const rest = address1.slice(name.length).replace(/^[\s,–—-]+/, '');
        if (rest && looksLikeStreet(rest)) address1 = rest;
    }

    // City embedded at end of street ("10701 W Bell Rd  Sun City")
    if (address1 && city && address1.toLowerCase().endsWith(city.toLowerCase())) {
        const cut = address1.slice(0, -city.length).replace(/[,\s]+$/, '');
        if (cut && looksLikeStreet(cut)) address1 = cut;
    } else if (address1 && !city) {
        const parsed = parseCompositeAddress(address1);
        if (parsed.city && parsed.street && parsed.street !== address1) {
            address1 = parsed.street;
            city = parsed.city;
            if (!state && parsed.state) state = parsed.state;
            if (!zip && parsed.zip) zip = parsed.zip;
        } else {
            // "800 SW 39th Street Sun City" — last capitalized multi-word without digits as city.
            // Do NOT treat street-type words or directional street remnants as city.
            const m = address1.match(/^(.*\d.*)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)$/);
            if (
                m
                && looksLikeStreet(m[1])
                && !looksLikeStreet(m[2])
                && !looksLikeHouseNumberOnly(m[1])
                && !/^(N|S|E|W|NE|NW|SE|SW)$/i.test(String(m[2]).split(/\s+/)[0] || '')
            ) {
                address1 = trimStr(m[1]);
                city = trimStr(m[2]);
            }
        }
    }

    // Zip stolen from house number (zip === leading street digits, often no real city)
    const leading = (address1.match(/^(\d{3,6})\b/) || [])[1];
    if (zip && leading && zip === leading) {
        zip = '';
    }
    // Zip that is clearly a street number (5 digits matching start) when state present but city empty
    if (zip && leading && zip === leading && state && !city) {
        zip = '';
    }

    // Name that is only an address blob — keep but don't treat as street source again
    if (name && looksLikeStreet(name) && !pi) {
        // leave name; display layer may still show it
    }

    // Sync composite for older readers: street-only, not full blob
    address = address1 || address;

    return {
        name: name || trimStr(site.id || ''),
        address1,
        address2,
        address,
        city,
        state,
        zip,
        zipCode: zip,
        phone: normalizePhone(site.phone || site.sitePhone || site.mainPhone || ''),
        piPhone: normalizePhone(site.piPhone || site.pi_phone || ''),
        siteCoordinatorPhone: normalizePhone(
            site.siteCoordinatorPhone || site.coordinatorPhone || ''
        ),
        contractsPhone: normalizePhone(
            site.contractsPhone || site.contractContactPhone || site.budgetContactPhone || ''
        ),
        pi,
        piFirstName,
        piLastName,
        piEmail,
        pi2Name,
        pi2Email,
        pi3Name,
        pi3Email,
        siteCoordinator: trimStr(site.siteCoordinator || site.coordinator || ''),
        siteCoordinatorEmail: trimStr(site.siteCoordinatorEmail || site.coordinatorEmail || ''),
    };
}

function resolveStreetAddress(site) {
    return normalizeSiteFields(site).address1;
}

function resolveCityStateZip(site) {
    const n = normalizeSiteFields(site);
    return { city: n.city, state: n.state, zip: n.zip };
}

function resolveSiteName(site) {
    return normalizeSiteFields(site).name;
}

function mapToLiveSiteFields(src) {
    return normalizeSiteFields(src);
}

function uniqueInvestigatorNames(site) {
    const n = normalizeSiteFields(site);
    const pairs = [
        [n.pi, n.piEmail],
        [n.pi2Name, n.pi2Email],
        [n.pi3Name, n.pi3Email],
    ];
    const seen = new Set();
    const out = [];
    for (const [name] of pairs) {
        const key = normKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

/** Prefill for ql-site-address: street + suite (joined) for the single survey field. */
function siteAddressPrefill(site) {
    const n = normalizeSiteFields(site);
    return [n.address1, n.address2].filter(Boolean).join(', ');
}

function siteNamePrefill(site) {
    return resolveSiteName(site);
}

/** Titles / credentials stripped when parsing person names. */
const PERSON_NAME_CREDENTIALS = /\b(md|m\.d\.|do|d\.o\.|phd|ph\.d\.|od|o\.d\.|dr|doctor|jr|sr|ii|iii|iv)\b/gi;

/**
 * Parse a person name into { first, last, display } with First Last ordering.
 * - Explicit first/last fields win
 * - "Last, First Middle" → First Middle Last
 * - Bare "TokenA TokenB" is kept as-is (assume already First … Last — do not auto-flip)
 */
function parsePersonName(raw, { firstName = '', lastName = '' } = {}) {
    let first = trimStr(firstName);
    let last = trimStr(lastName);
    const original = trimStr(raw);

    if (first || last) {
        const display = [first, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        return { first, last, display: display || original };
    }

    if (!original) return { first: '', last: '', display: '' };

    // "Last, First Middle"
    if (original.includes(',')) {
        const [left, ...rest] = original.split(',');
        last = trimStr(left).replace(PERSON_NAME_CREDENTIALS, ' ').replace(/\s+/g, ' ').trim();
        first = rest.join(',').replace(PERSON_NAME_CREDENTIALS, ' ').replace(/\s+/g, ' ').trim();
        const display = [first, last].filter(Boolean).join(' ').trim();
        return { first, last, display: display || original };
    }

    const cleaned = original.replace(PERSON_NAME_CREDENTIALS, ' ').replace(/\s+/g, ' ').trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { first: '', last: '', display: original };
    if (parts.length === 1) return { first: parts[0], last: '', display: parts[0] };

    // Assume already First … Last (Western clinical default). Keep order.
    first = parts.slice(0, -1).join(' ');
    last = parts[parts.length - 1];
    return { first, last, display: `${first} ${last}`.trim() };
}

/** Prefer First Last for survey prefill / display. */
function formatPersonNameFirstLast(raw, opts = {}) {
    return parsePersonName(raw, opts).display;
}

/**
 * Soft check: does email local-part look like it belongs to this First Last name?
 * Catches Last-First / wrong-PI mix-ups without forced flips on bare two-token names.
 */
function personNameMatchesEmail(displayName, email) {
    const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    if (!local || local.length < 3) return true;
    const { first, last } = parsePersonName(displayName);
    const f = first.toLowerCase().replace(/[^a-z]/g, '');
    const l = last.toLowerCase().replace(/[^a-z]/g, '');
    if (l && l.length >= 3 && local.includes(l)) return true;
    if (f && f.length >= 3 && local.includes(f)) return true;
    // initials style: madam → m + adam
    if (f && l && local.length >= 3) {
        const initialFirst = `${f[0]}${l}`;
        const initialLast = `${l[0]}${f}`;
        if (local === initialFirst || local === initialLast) return true;
        if (local.startsWith(initialFirst) || local.startsWith(initialLast)) return true;
        if (initialFirst.startsWith(local.slice(0, Math.min(local.length, initialFirst.length)))) {
            if (local.includes(f) || local.includes(l)) return true;
        }
    }
    return false;
}

module.exports = {
    looksLikeStreet,
    looksLikeHouseNumberOnly,
    looksLikeUnitLine,
    looksLikeCityOnly,
    normalizePhone,
    splitStreetAndUnit,
    parseCompositeAddress,
    normalizeSiteFields,
    resolveStreetAddress,
    resolveCityStateZip,
    resolveSiteName,
    mapToLiveSiteFields,
    uniqueInvestigatorNames,
    siteAddressPrefill,
    siteNamePrefill,
    parsePersonName,
    formatPersonNameFirstLast,
    personNameMatchesEmail,
};
