// US regions for the nationwide search. Pure and import-free (shared by the
// browser, the sync proxy and the scheduled sync).
//
// Salt belt: states that salt their roads heavily enough to make underbody rust a
// real risk on a used car. By default the search leaves their dealers out
// entirely (MarketCheck's `state=` filter, so they don't use up results or
// calls); Settings can switch that to just flagging them. The dealer's state is
// only a proxy — a car can have lived elsewhere — which is why flagging exists.

export const ALL_STATES = ("AL,AK,AZ,AR,CA,CO,CT,DC,DE,FL,GA,HI,ID,IL,IN,IA,KS,KY,LA,ME,MD,MA,MI,MN,MS,MO,MT,NE,NV,NH," +
  "NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY").split(",");

export const SALT_STATES = "CT,DC,DE,IA,IL,IN,MA,MD,ME,MI,MN,MO,ND,NE,NH,NJ,NY,OH,PA,RI,SD,VT,WI,WV".split(",");

export function isSaltState(st) {
  return SALT_STATES.indexOf(String(st || "").trim().toUpperCase()) > -1;
}

// The states a search covers: everything but the salt belt when excluding it,
// else every state. (A list is always sent so a too-big search can be split.)
export function searchStates(excludeSalt) {
  return excludeSalt ? ALL_STATES.filter(function (s) { return !isSaltState(s); }) : ALL_STATES.slice();
}
