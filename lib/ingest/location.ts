import type { LocationClass } from "@/db/schema";

const SF_RE = /\b(san francisco|sf\b|bay area|south bay|peninsula|silicon valley|palo alto|mountain view|menlo park|sunnyvale|cupertino|santa clara|san jose|redwood city|berkeley|oakland|alameda|burlingame|foster city|san mateo|emeryville|fremont)\b/i;
const NYC_RE = /\b(new york|nyc|manhattan|brooklyn|queens|bronx|jersey city|hoboken|long island city|lic\b)\b/i;
const REMOTE_RE = /\bremote\b/i;
const US_RE = /\b(usa|united states|us\b|us-only|us only)\b/i;
const NON_US_RE =
  /\b(canada|toronto|vancouver|montreal|uk|london|berlin|munich|paris|tokyo|singapore|sydney|melbourne|israel|tel aviv|bangalore|hyderabad|mumbai|delhi|amsterdam|dublin|europe|emea|apac|latam|poland|warsaw|krakow|spain|madrid|barcelona|portugal|lisbon|italy|milan|rome|france|germany|netherlands|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|switzerland|zurich|austria|vienna|czech|prague|romania|bucharest|hungary|budapest|ukraine|kyiv|estonia|tallinn|japan|korea|seoul|china|shanghai|beijing|taiwan|taipei|hong kong|philippines|manila|indonesia|jakarta|vietnam|thailand|bangkok|malaysia|egypt|nigeria|lagos|kenya|nairobi|south africa|colombia|bogot[aá]|brazil|s[aã]o paulo|mexico|argentina|buenos aires|chile|santiago|peru|lima|costa rica|uruguay|ireland|new zealand|auckland)\b/i;

export function classify(locationRaw: string): LocationClass {
  if (!locationRaw) return "other";
  const s = locationRaw.toLowerCase();
  if (SF_RE.test(s)) return "sf";
  if (NYC_RE.test(s)) return "nyc";
  if (REMOTE_RE.test(s)) {
    if (NON_US_RE.test(s) && !US_RE.test(s)) return "other";
    return "remote_us";
  }
  return "other";
}

export function isTarget(loc: LocationClass): boolean {
  return loc === "sf" || loc === "nyc" || loc === "remote_us";
}

/**
 * Quant hubs outside the SF/NYC targets — quant roles in these cities are
 * admitted anyway (Chicago is THE quant city; excluding it would drop half
 * the industry). Only applies to quant-titled roles.
 */
const QUANT_HUB_RE = /\b(chicago|philadelphia|philly|boston|austin|greenwich|stamford|miami)\b/i;

export function isQuantHub(locationRaw: string): boolean {
  return QUANT_HUB_RE.test(locationRaw) && !NON_US_RE.test(locationRaw.toLowerCase());
}
