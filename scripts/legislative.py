#!/usr/bin/env python3
"""Writes legislative/districts.json, the Assembly and Senate districts each
agency's territory touches, and legislative/sources.csv, the boundary used for
every agency that has no TIGER layer of its own.

  python -I scripts/legislative.py fetch --geo <raw dir>
  python -I scripts/legislative.py build --geo <raw dir> [--data-root <mfa-data>]

fetch downloads what build reads into <raw dir>, skipping files it already
holds: TIGER/Line 2026 (districts, places, counties, school districts), the
2020 PL 94-171 file (block interior points and population), the Statewide
Database block equivalency files of the 2021 Commission maps, and special
district boundaries from public ArcGIS layers. It sends about one request a
second to each host and stops on any refusal.

build needs shapely 2, pyshp and pyproj. It reads the release CSVs from
--data-root (an mfa-data checkout or archive; default MFA_DATA_ROOT, then
../mfa-data beside this repository) and coverage/coverage.json and
apr/apr.json from this repository. The output is sorted, and built_utc is kept
when nothing else changed, so a rebuild from the same inputs is byte for byte
the same file. Run it at nice 19: it takes about two minutes.
"""

import argparse
import collections
import csv
import datetime
import gzip
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
csv.field_size_limit(1 << 30)

# ------------------------------------------------------------ inputs

DOWNLOADS = {
    "tiger2026/tl_2026_06_sldl.zip": "https://www2.census.gov/geo/tiger/TIGER2026/SLDL/tl_2026_06_sldl.zip",
    "tiger2026/tl_2026_06_sldu.zip": "https://www2.census.gov/geo/tiger/TIGER2026/SLDU/tl_2026_06_sldu.zip",
    "tiger2026/tl_2026_06_place.zip": "https://www2.census.gov/geo/tiger/TIGER2026/PLACE/tl_2026_06_place.zip",
    "tiger2026/tl_2026_us_county.zip": "https://www2.census.gov/geo/tiger/TIGER2026/COUNTY/tl_2026_us_county.zip",
    "tiger2026/tl_2026_06_unsd.zip": "https://www2.census.gov/geo/tiger/TIGER2026/UNSD/tl_2026_06_unsd.zip",
    "tiger2026/tl_2026_06_elsd.zip": "https://www2.census.gov/geo/tiger/TIGER2026/ELSD/tl_2026_06_elsd.zip",
    "tiger2026/tl_2026_06_scsd.zip": "https://www2.census.gov/geo/tiger/TIGER2026/SCSD/tl_2026_06_scsd.zip",
    "pl2020/ca2020.pl.zip": "https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/California/ca2020.pl.zip",
    "swdb2021/2021_AD_Final_equiv.zip": "https://statewidedatabase.org/pub/data/D20/FINAL_MAPS/2021_AD_Final_equiv.zip",
    "swdb2021/2021_SD_Final_equiv.zip": "https://statewidedatabase.org/pub/data/D20/FINAL_MAPS/2021_SD_Final_equiv.zip",
}

# Special district layers. Statewide ones are large, so fetch keeps their
# attribute tables whole and downloads geometry only for the features a
# release agency names or a roster name matches.
LAYERS = {
    "calfire": {
        "url": "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/California_Local_Fire_Districts/FeatureServer/0",
        "id": "OBJECTID", "name": "Name", "county": "County",
        "fields": ["OBJECTID", "Name", "County", "FDID", "LastUpdated"],
        "label": "CAL FIRE, California Local Fire Districts (April 2026)", "statewide": True,
    },
    "csda": {
        "url": "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/CSDA_Special_District_Boundaries/FeatureServer/0",
        "id": "FID", "name": "COMPANY", "fields": ["FID", "COMPANY", "TYPE"],
        "label": "CSDA special district boundaries (FEMA Region 9 copy, March 2021)", "statewide": True,
    },
    "dwr": {
        "url": "https://gis.water.ca.gov/arcgis/rest/services/Boundaries/i03_WaterDistricts/FeatureServer/0",
        "id": "OBJECTID", "name": "AGENCYNAME", "fields": ["OBJECTID", "AGENCYNAME", "SOURCE", "LASTMODIFIEDDATE"],
        "label": "DWR i03 Water Districts", "statewide": True,
    },
    "sacparks": {
        "url": "https://services1.arcgis.com/5NARefyPVtAeuJPU/arcgis/rest/services/Parks_and_Recreation/FeatureServer/2",
        "id": "OBJECTID", "name": "DISTRICT", "fields": ["OBJECTID", "DISTRICT", "LONG_DISTRICT"],
        "label": "Sacramento County GIS, Park Districts",
    },
    "venturalafco": {
        "url": "https://maps.venturacounty.gov/arcgis/rest/services/LAFCo/SpecialDistricts_CurrentBoundary/FeatureServer/420",
        "id": "OBJECTID", "name": "NAME", "fields": ["OBJECTID", "NAME"],
        "label": "Ventura LAFCo, current special district boundaries",
    },
    "napasan": {
        "url": "https://gis.napacounty.gov/arcgis/rest/services/Hosted/Napa_Sanitation_Boundary/FeatureServer/0",
        # district is YES on the parts inside the district
        "id": "objectid", "name": "district", "fields": ["objectid", "district"], "show_name": False,
        "label": "Napa County GIS, Napa Sanitation District boundary",
    },
    "deltadiablo": {
        "url": "https://services2.arcgis.com/ddLMx2TX2Kj4K2Wb/arcgis/rest/services/SewerSystem_ServiceAreaPublic_view/FeatureServer/920",
        "id": "objectid", "name": "name", "fields": ["objectid", "name"],
        "label": "Delta Diablo, sewer service territory",
    },
    "mshcp": {
        "url": "https://gis.conserveriverside.com/arcgis/rest/services/PublicServices/MSHCP_Boundary/MapServer/0",
        "id": "objectid", "name": "boundary_name", "fields": ["objectid", "boundary_name"],
        "label": "Western Riverside County RCA, MSHCP plan area",
    },
    "scvhabitat": {
        "url": "https://services2.arcgis.com/tcv2cMrq63AgvbHF/arcgis/rest/services/Habitat_Plan_Permit_Area/FeatureServer/0",
        "id": "OBJECTID", "name": None, "fields": ["OBJECTID"],
        "label": "Santa Clara County Planning, Habitat Plan permit area",
    },
}
STATEWIDE = ("calfire", "csda", "dwr")  # roster matching tries them in this order
TIGER_LABEL = "Census TIGER/Line 2026"

# ------------------------------------------------------------ names

DASHES = "-‐‑‒–—―/"


def norm_name(s):
    """Port of lib/apr.js normName: strip accents, upper case, & to AND,
    dashes and slashes to spaces, drop other punctuation."""
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(ch for ch in s if not ("̀" <= ch <= "ͯ"))
    s = s.upper().replace("&", " AND ")
    s = "".join(" " if ch in DASHES else ch for ch in s)
    s = re.sub(r"[^A-Z0-9 ]", "", s)
    return re.sub(r"\s+", " ", s).strip()


TOKEN_ALIASES = {"MT": "MOUNT", "SAINT": "ST", "STE": "SAINTE"}


def norm_tokens(s):
    """norm_name plus the token spellings that differ between CDE, the release
    and TIGER: 'Mt.' is 'Mount', 'Saint' is 'St.'."""
    return " ".join(TOKEN_ALIASES.get(t, t) for t in norm_name(s).split())


def paren_variants(name):
    """'El Paso de Robles (Paso Robles)' answers to the whole name, the part
    before the parenthesis and the part inside it."""
    m = re.match(r"^(.+?)\s*\((.+)\)\s*$", name)
    out = [name] + ([m.group(1), m.group(2)] if m else [])
    seen, res = set(), []
    for v in out:
        k = norm_tokens(v)
        if k and k not in seen:
            seen.add(k)
            res.append(k)
    return res


# Spellings the Permits tab already accepts (lib/apr.js APR_ALIASES), by
# normalized name only; the county check still applies.
PLACE_ALIASES = {
    "ANGELS CAMP": "ANGELS", "CARMEL": "CARMEL BY THE SEA", "CATHEDRAL": "CATHEDRAL CITY",
    "VENTURA": "SAN BUENAVENTURA", "PASO ROBLES": "EL PASO DE ROBLES",
}
PLACE_TYPES = {"city", "town", "incorporated_city_or_town", "city_and_county", ""}
COUNTY_TYPES = {"county", "city_and_county", ""}
SCHOOL_TYPES = {"school_district", "unified_school_district", "elementary_school_district", "high_school_district"}
GEO_SCHOOL = {"elementary_school_district", "high_school_district", "unified_school_district"}
SF_NAMES = re.compile(r"^City (?:and|&) County of San Francisco$", re.I)


def place_base(name):
    for pat in (r"^(?:City|Town) of (.+)$", r"^(.+) (?:city|town)$"):
        m = re.match(pat, name.strip(), re.I)
        if m:
            return m.group(1).strip()
    return ""


def county_base(name):
    for pat in (r"^County of (.+)$", r"^(.+) County$"):
        m = re.match(pat, name.strip(), re.I)
        if m:
            return m.group(1).strip()
    return ""


SD_ABBREV = {
    "JT": ["JOINT"], "JNT": ["JOINT"], "UN": ["UNION"], "ELEM": ["ELEMENTARY"], "EL": ["ELEMENTARY"],
    "USD": ["UNIFIED"], "JUSD": ["JOINT", "UNIFIED"], "ESD": ["ELEMENTARY"], "UESD": ["UNION", "ELEMENTARY"],
    "UHSD": ["UNION", "HIGH"], "JUHSD": ["JOINT", "UNION", "HIGH"], "HSD": ["HIGH"], "HS": ["HIGH"],
    "SD": [], "UFSD": ["UNIFIED"], "SCH": ["SCHOOL"], "DIST": ["DISTRICT"],
}
SD_TAIL = {"SCHOOL", "DISTRICT", "SCHOOLS"}
SD_LEVEL = {"UNIFIED": "unsd", "ELEMENTARY": "elsd", "HIGH": "scsd", "SECONDARY": "scsd"}
SD_FILLER = {"JOINT", "UNION", "CONSOLIDATED", "CHARTER"}
SD_FAMILIES = ("full", "nojoint", "nofiller", "core")


def sd_tokens(name):
    n = re.sub(r"\s*\((?:\d+|K|PK)\s*-\s*\d+\)\s*$", "", name.strip())  # TIGER '(9-12)'
    toks = []
    for t in norm_tokens(n).split():
        toks += SD_ABBREV.get(t, [t])
    while toks and toks[-1] in SD_TAIL:
        toks.pop()
    return toks


def sd_keys(name):
    """Keys by family, strict to loose. The core family also drops the joint,
    union and level words and a trailing CITY or COUNTY ('San Diego City
    Unified' is 'San Diego Unified'); it is used only with a level."""
    toks = sd_tokens(name)
    fam = {
        "full": {" ".join(toks)},
        "nojoint": {" ".join(t for t in toks if t != "JOINT")},
        "nofiller": {" ".join(t for t in toks if t not in SD_FILLER)},
    }
    core = [t for t in toks if t not in SD_FILLER and t not in SD_LEVEL]
    cores = {" ".join(core)}
    while len(core) > 1 and core[-1] in ("CITY", "COUNTY"):
        core = core[:-1]
        cores.add(" ".join(core))
    fam["core"] = cores
    fam = {k: {x for x in v if x} for k, v in fam.items()}
    return fam, {SD_LEVEL[t] for t in toks if t in SD_LEVEL}


def sd_full(name):
    return next(iter(sd_keys(name)[0]["full"]), "")


def split_counties(c):
    return [x.strip() for x in re.split(r"[;,]", c or "") if x.strip()]


# Special district names: CAL FIRE and DWR abbreviate, the roster sometimes
# adds the county in parentheses ('Camarillo Sanitary District (Ventura)').
SPECIAL_ABBREV = {
    "FPD": "FIRE PROTECTION DISTRICT", "CSD": "COMMUNITY SERVICES DISTRICT", "MWD": "MUNICIPAL WATER DISTRICT",
    "CWD": "COUNTY WATER DISTRICT", "WD": "WATER DISTRICT", "PUD": "PUBLIC UTILITY DISTRICT",
    "RPD": "RECREATION AND PARK DISTRICT", "DIST": "DISTRICT", "REC": "RECREATION",
}


def special_key(name, county_keys):
    n = name.strip()
    m = re.match(r"^(.*\S)\s*\(([^()]*)\)$", n)
    if m and norm_name(m.group(2)) in county_keys:
        n = m.group(1)
    toks = []
    for t in norm_tokens(n).split():
        toks += SPECIAL_ABBREV.get(t, t).split()
    s = " ".join(toks).replace("COMMUNITY SERVICE DISTRICT", "COMMUNITY SERVICES DISTRICT")
    return s[4:] if s.startswith("THE ") else s


# ------------------------------------------------------------ release agencies with no TIGER layer
#
# Keyed by the release's exact receiving_entity spellings. refs name the
# features: (layer, exact name) for an ArcGIS layer (every piece with that
# name), ("county", NAME), ("place", NAME) or ("unsd", NAME) for TIGER.
# district_boundary and approximate polygons that are not TIGER are counted by
# 2020 block interior points, because their edges do not follow TIGER's.

CF, CS, DW = "calfire", "csda", "dwr"


def _sp(names, basis, refs, note="", roster=None):
    """roster names the roster row when its name differs from the
    release's beyond what special_key settles."""
    return {"names": names, "basis": basis, "refs": refs, "note": note, "roster": roster}


SPECIAL = [
    # Fire: CAL FIRE 2026 first, CSDA 2021 where CAL FIRE has none.
    _sp(["American Canyon Fire Protection District"], "district_boundary", [(CF, "AMERICAN CANYON FIRE")]),
    _sp(["Amador Fire Protection District"], "district_boundary", [(CF, "AMADOR FPD")]),
    _sp(["Apple Valley Fire Protection District"], "district_boundary", [(CF, "APPLE VALLEY FPD")]),
    _sp(["Bear Valley-Indian Valley Fire Protection District"], "district_boundary", [(CF, "BEAR VLY INDIAN VLY FPD")]),
    _sp(["Consolidated Fire Protection District of Los Angeles County"], "district_boundary", [(CF, "LOS ANGELES CO FD")],
        "CAL FIRE's Los Angeles County Fire Department area, which includes the cities it serves by contract.",
        roster="Consolidated Fire Protection District"),
    _sp(["DIAMOND SPRINGS – EL DORADO FIRE PROTECTION DISTRICT", "Diamond Springs / El Dorado Fire Protection District"],
        "district_boundary", [(CF, "DIAMOND SPRINGS - EL DORADO FPD")]),
    _sp(["East Contra Costa Fire Protection District"], "district_boundary", [(CS, "East Contra Costa Fire Protection District")],
        "CSDA 2021 boundary; the district has since been annexed to the Contra Costa County Fire Protection District."),
    _sp(["El Dorado County Fire Protection District"], "district_boundary", [(CF, "EL DORADO CO FPD")]),
    _sp(["Esparto Fire Protection District"], "district_boundary", [(CF, "ESPARTO FPD")]),
    _sp(["Garden Valley Fire Protection District"], "district_boundary", [(CF, "GARDEN VALLEY FPD")]),
    _sp(["Georgetown Fire Protection District"], "district_boundary", [(CF, "GEORGETOWN FD")]),
    _sp(["Hughson Fire Protection District"], "district_boundary", [(CF, "HUGHSON FIRE PROTECTION DISTRICT")]),
    _sp(["Jackson Valley Fire Protection District"], "district_boundary", [(CF, "JACKSON VALLEY FPD")]),
    _sp(["Lake Valley Fire Protection District"], "district_boundary", [(CF, "LAKE VALLEY FPD")]),
    _sp(["Lakeport Fire Protection District"], "district_boundary", [(CF, "LAKEPORT")]),
    _sp(["Lathrop-Manteca Fire Protection District"], "district_boundary", [(CF, "LATHROP-MANTECA FIRE PROTECTION DISTRICT")]),
    _sp(["Lockwood Fire Protection District"], "district_boundary", [(CF, "LOCKWOOD FPD")]),
    _sp(["Mokelumne Rural Fire Protection District"], "district_boundary", [(CF, "MOKELUMNE RURAL COUNTY FIRE DISTRICT")]),
    _sp(["Newcastle Fire Protection District"], "district_boundary", [(CF, "NEWCASTLE FPD")],
        roster="Newcastle Fire Protection District"),
    _sp(["Mosquito Fire Protection District"], "district_boundary", [(CF, "MOSQUITO FPD")]),
    _sp(["Oakdale Rural Fire Protection District"], "district_boundary", [(CS, "Oakdale Fire Protection District")]),
    _sp(["Penn Valley Fire Protection District"], "district_boundary", [(CF, "PENN VALLEY FPD")]),
    _sp(["Pioneer Fire Protection District"], "district_boundary", [(CF, "PIONEER FPD")]),
    _sp(["Rescue Fire Protection District"], "district_boundary", [(CF, "RESCUE FPD")]),
    _sp(["Ripon Consolidated Fire Protection District"], "district_boundary", [(CF, "RIPON CONSOLIDATED FIRE PROTECTION DISTRICT")]),
    _sp(["Rodeo-Hercules Fire Protection District"], "district_boundary", [(CF, "RODEO HERCULES FD")]),
    _sp(["Sacramento Metropolitan Fire District"], "district_boundary",
        [(CF, "SACRAMENTO METROPOLITAN FD"), (CF, "SACRAMENTO METROPOLITAN FIRE DISTRICT")]),
    _sp(["Sonoma County Fire District"], "district_boundary", [(CF, "SONOMA COUNTY FIRE DISTRICT")]),
    _sp(["Sonoma Valley Fire District"], "district_boundary", [(CF, "SONOMA VALLEY FIRE DISTRICT")]),
    _sp(["South Placer Fire Protection District"], "district_boundary", [(CF, "SOUTH PLACER FPD")]),
    _sp(["Stanislaus Consolidated Fire Protection District"], "district_boundary",
        [(CF, "STANISLAUS CONSOLIDATED FIRE PROTECTION DISTRICT")]),
    _sp(["Suisun Fire Protection District"], "district_boundary", [(CF, "SUISUN FPD")]),
    _sp(["Vacaville Fire Protection District"], "district_boundary", [(CF, "VACAVILLE FPD")]),
    _sp(["Westport Fire Protection District"], "district_boundary", [(CF, "WESTPORT FIRE PROTECTION DISTRICT")]),
    _sp(["Woodbridge Fire Protection District"], "district_boundary", [(CF, "WOODBRIDGE RURAL COUNTY FIRE PROTECTION DISTRICT")]),
    # Water: CSDA first, DWR i03 where CSDA has none.
    _sp(["Alameda County Water District"], "district_boundary", [(CS, "Alameda County Water District")]),
    _sp(["Amador Water Agency"], "district_boundary", [(CS, "Amador Water Agency")]),
    _sp(["Camrosa Water District"], "district_boundary", [(CS, "Camrosa Water District")]),
    _sp(["Casitas Municipal Water District"], "district_boundary", [(CS, "Casitas Municipal Water District")]),
    _sp(["Contra Costa Water District"], "district_boundary", [(CS, "Contra Costa Water District")]),
    _sp(["Cottonwood Water District"], "district_boundary", [(CS, "Cottonwood Water District")]),
    _sp(["Idyllwild Water District"], "district_boundary", [(CS, "Idyllwild Water District")]),
    _sp(["Indio Water Authority"], "district_boundary", [(DW, "Indio Water Authority")]),
    _sp(["Rincon Del Diablo Municipal Water District"], "district_boundary", [(CS, "Rincon del Diablo Municipal Water District")]),
    _sp(["Sacramento County Water Agency"], "district_boundary", [(DW, "Sacramento County Water Agency")],
        "DWR maps the agency's service zones, not the whole county."),
    _sp(["San Dieguito Water District"], "district_boundary", [(DW, "San Dieguito Water District")]),
    _sp(["Santa Clarita Valley Water Agency"], "district_boundary", [(DW, "Santa Clarita Valley Water Agency")]),  # CSDA has no polygon
    _sp(["Soquel Creek Water District"], "district_boundary", [(CS, "Soquel Creek Water District")]),
    _sp(["South Coast Water District"], "district_boundary", [(CS, "South Coast Water District")]),
    _sp(["Trabuco Canyon Water District"], "district_boundary", [(CS, "Trabuco Canyon Water District")]),
    _sp(["Valley of the Moon Water District"], "district_boundary", [(CS, "Valley of the Moon Water District")]),
    _sp(["Westborough County Water District"], "district_boundary", [(CS, "Westborough Water District")]),
    _sp(["Zone 7 Water Agency"], "district_boundary", [(CS, "Zone 7 Water Agency")]),
    # Sanitation
    _sp(["COSTA MESA SANITARY DISTRICT", "Costa Mesa Sanitary District"], "district_boundary", [(CS, "Costa Mesa Sanitary District")]),
    _sp(["Castro Valley Sanitary District"], "district_boundary", [(CS, "Castro Valley Sanitary District")]),
    _sp(["Central Contra Costa Sanitary District"], "district_boundary", [(CS, "Central Contra Costa Sanitary District")]),
    _sp(["Dublin San Ramon Services District"], "district_boundary", [(CS, "Dublin San Ramon Services District")]),
    _sp(["Stege Sanitary District"], "district_boundary", [(CS, "Stege Sanitary District")]),
    _sp(["Camarillo Sanitary District"], "district_boundary", [("venturalafco", "Camarillo Sanitary District")]),
    _sp(["Napa Sanitation District"], "district_boundary", [("napasan", "YES")]),
    _sp(["Delta Diablo"], "district_boundary", [("deltadiablo", None)],
        "Delta Diablo's sewer service territory, not its LAFCo boundary."),
    # Parks
    _sp(["Arcade Creek Recreation and Park District"], "district_boundary", [("sacparks", "Arcade Creek")]),
    _sp(["Carmichael Recreation and Park District"], "district_boundary", [("sacparks", "Carmichael")]),
    _sp(["Fair Oaks Recreation and Park District"], "district_boundary", [("sacparks", "Fair Oaks")]),
    _sp(["Mission Oaks Recreation and Park District"], "district_boundary", [("sacparks", "Mission Oaks")]),
    _sp(["North Highlands Recreation and Park District"], "district_boundary", [("sacparks", "North Highlands")]),
    _sp(["Southgate Recreation and Park District"], "district_boundary", [("sacparks", "Southgate")]),
    _sp(["Sunrise Recreation and Park District"], "district_boundary", [("sacparks", "Sunrise")]),
    _sp(["Chico Area Recreation and Park District"], "district_boundary", [(CS, "Chico Area Recreation and Park District")]),
    _sp(["Durham Recreation and Park District"], "district_boundary", [(CS, "Durham Recreation and Park District")]),
    _sp(["Feather River Recreation and Park District"], "district_boundary", [(CS, "Feather River Recreation and Park District")]),
    _sp(["Paradise Recreation and Park District"], "district_boundary", [(CS, "Paradise Recreation and Park District")]),
    _sp(["Georgetown Divide Recreation District"], "district_boundary", [(CS, "Georgetown Divide Recreation District")]),
    # Community services districts
    _sp(["Avila Beach Community Services District"], "district_boundary", [(CS, "Avila Beach Community Services District")]),
    _sp(["CAMERON PARK COMMUNITY SERVICE DISTRICT", "Cameron Park Community Services District"], "district_boundary",
        [(CS, "Cameron Park Community Services District")]),
    _sp(["Cosumnes Community Services District"], "district_boundary", [(CS, "Cosumnes Community Services District")]),
    _sp(["Crockett Community Services District"], "district_boundary", [(CS, "Crockett Community Services District")]),
    _sp(["EL DORADO HILLS COMMUNITY SERVICE DISTRICT"], "district_boundary", [(CS, "El Dorado Hills Community Services District")]),
    _sp(["Nipomo Community Services District"], "district_boundary", [(CS, "Nipomo Community Services District")]),
    _sp(["San Miguel Community Services District"], "district_boundary", [(CS, "San Miguel Community Services District")]),
    _sp(["Santa Ynez Community Services District"], "district_boundary", [(CS, "Santa Ynez Community Services District")]),
    _sp(["Templeton Community Services District"], "district_boundary", [(CS, "Templeton Community Services District")]),
    _sp(["Tomales Village Community Services District"], "district_boundary", [(CS, "Tomales Village Community Services District")]),
    _sp(["Town of Discovery Bay Community Services District"], "district_boundary",
        [(CS, "Town of Discovery Bay Community Services District")]),
    _sp(["Vandenberg Village Community Services District"], "district_boundary",
        [(CS, "Vandenberg Village Community Services District")]),
    # Habitat agencies
    _sp(["Western Riverside County Regional Conservation Authority"], "district_boundary", [("mshcp", None)],
        "The MSHCP plan area the authority administers."),
    _sp(["Santa Clara Valley Habitat Agency"], "district_boundary", [("scvhabitat", None)],
        "The Habitat Plan permit area the agency administers."),
    # Same boundary as a county or school district.
    _sp(["Tehama County Air Pollution Control District"], "same_as", [("county", "Tehama")], "Same boundary as Tehama County."),
    _sp(["Sacramento Transportation Authority"], "same_as", [("county", "Sacramento")], "Same boundary as Sacramento County."),
    _sp(["Solano Transportation Authority"], "same_as", [("county", "Solano")], "Same boundary as Solano County."),
    _sp(["Amador County Transportation Commission"], "same_as", [("county", "Amador")], "Same boundary as Amador County."),
    _sp(["Nevada County Transportation Commission"], "same_as", [("county", "Nevada")], "Same boundary as Nevada County."),
    _sp(["Contra Costa County Flood Control and Water Conservation District"], "same_as", [("county", "Contra Costa")],
        "Taken as the whole of Contra Costa County; the statute was not checked."),
    _sp(["Vacaville Unified School Library District"], "same_as", [("unsd", "Vacaville Unified School District")],
        "Taken as the Vacaville Unified School District boundary; not checked."),
    # Approximate: a superset, or the union of member agencies.
    _sp(["Riverside County Flood Control and Water Conservation District"], "approximate", [("county", "Riverside")],
        "Riverside County as a superset; the district covers only the western part of the county.",
        roster="Riverside County Flood Control and Water Conservation"),
    _sp(["Sacramento Regional Transit District"], "approximate", [("county", "Sacramento")],
        "Sacramento County as a superset of the transit district; no boundary layer was found."),
    _sp(["Chula Vista Redevelopment Agency"], "approximate", [("place", "Chula Vista")],
        "City of Chula Vista as a superset of the former redevelopment project areas (dissolved 2012)."),
    _sp(["Redevelopment Agency of the City of Davis"], "approximate", [("place", "Davis")],
        "City of Davis as a superset of the former redevelopment project area (dissolved 2012)."),
    _sp(["Riverside County Habitat Conservation Agency"], "approximate", [("mshcp", None)],
        "The western Riverside County MSHCP plan area as a superset of the agency's habitat plan area."),
    _sp(["City of Lakeport Municipal Sewer District"], "approximate", [("place", "Lakeport")],
        "City of Lakeport as the sewer district's boundary; not checked.",
        roster="City of Lakeport Municipal Sewer District No. 1"),
    _sp(["Lake County Sanitation District"], "approximate", [("county", "Lake")],
        "Lake County as a superset of the sanitation district."),
    _sp(["Ceres Fire Protection District"], "approximate", [("place", "Ceres")],
        "No boundary layer has the district; the City of Ceres, which serves it, stands in and may miss districts."),
    _sp(["South Placer Wastewater Authority"], "approximate", [("place", "Roseville"), (CS, "South Placer Municipal Utility District")],
        "Union of members Roseville and South Placer MUD (CSDA 2021); the Placer County member is not mapped."),
    _sp(["Tri-Valley Transportation Council"], "approximate",
        [("place", "Dublin"), ("place", "Livermore"), ("place", "Pleasanton"), ("place", "San Ramon"), ("place", "Danville")],
        "Union of member cities and town; the unincorporated county areas it covers are not mapped."),
    _sp(["West Contra Costa Transportation Advisory Committee (WCCTAC)"], "approximate",
        [("place", "El Cerrito"), ("place", "Hercules"), ("place", "Pinole"), ("place", "Richmond"), ("place", "San Pablo")],
        "Union of member cities; the unincorporated county areas it covers are not mapped."),
    _sp(["East Contra Costa Regional Fee and Financing Authority"], "approximate",
        [("place", "Antioch"), ("place", "Brentwood"), ("place", "Oakley"), ("place", "Pittsburg")],
        "Union of member cities; the unincorporated county areas it covers are not mapped."),
    _sp(["South Placer Regional Transportation Authority"], "approximate",
        [("place", "Roseville"), ("place", "Rocklin"), ("place", "Lincoln")],
        "Union of member cities; the unincorporated Placer County area it covers is not mapped."),
    _sp(["Bizz Johnson Highway Interchange Joint Powers Authority"], "unmapped", [],
        "Members not established (the joint powers agreement was not read), so no boundary is mapped."),
]

# Two-district boards, and CDE renames TIGER 2026 still carries under the old
# name (the TIGER feature is otherwise unclaimed, same county).
SD_MANUAL = {
    "SANTA ROSA CITY SCHOOLS SANTA ROSA ELEMENTARY AND SANTA ROSA HIGH": [
        ("elsd", "Santa Rosa Elementary School District"), ("scsd", "Santa Rosa High School District")],
    "SANTA ROSA CITY SCHOOLS": [
        ("elsd", "Santa Rosa Elementary School District"), ("scsd", "Santa Rosa High School District")],
}
SD_RENAMES = {
    ("LARKSPUR CORTE MADERA", "Marin"): ("elsd", "Larkspur Elementary School District"),
    ("SAUSALITO MARIN CITY", "Marin"): ("elsd", "Sausalito Elementary School District"),
    ("MILLER CREEK ELEMENTARY", "Marin"): ("elsd", "Dixie Elementary School District"),
}
TYPE_LEVEL = {"unified_school_district": "unsd", "elementary_school_district": "elsd", "high_school_district": "scsd"}
# Release names with no county and no roster link, settled from the source.
RELEASE_COUNTY_HINTS = {
    "Evergreen School District": "Santa Clara",  # official_source_url host eesd.org (Evergreen ESD, San Jose)
}

# ------------------------------------------------------------ polite fetch

UA = "Mozilla/5.0 (compatible; mfa.amyc.us legislative district build)"


class Polite:
    """One request a second per host; any refusal stops the run."""

    def __init__(self):
        self.last = {}

    def get(self, url, params=None, timeout=300):
        host = urllib.parse.urlsplit(url).netloc
        wait = self.last.get(host, 0) + 1.1 - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        full = url + ("?" + urllib.parse.urlencode(params) if params else "")
        req = urllib.request.Request(full, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise SystemExit(f"stopped: HTTP {e.code} from {host}")
        finally:
            self.last[host] = time.monotonic()

    def query(self, layer_url, params):
        body = self.get(layer_url.rstrip("/") + "/query", params)
        d = json.loads(body)
        if isinstance(d, dict) and "error" in d:
            raise SystemExit(f"stopped: {layer_url} answered {d['error']}")
        return d


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def special_dir(geo):
    return os.path.join(geo, "special")


def attrs_path(geo, key):
    return os.path.join(special_dir(geo), f"{key}.attrs.json")


def geom_path(geo, key):
    return os.path.join(special_dir(geo), f"{key}.geojson.gz")


def read_geojson(path):
    if not os.path.exists(path):
        return {}
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        d = json.load(fh)
    return {f["id"]: f for f in d["features"]}


def write_geojson(path, feats):
    d = {"type": "FeatureCollection", "features": [feats[k] for k in sorted(feats)]}
    write_atomic(path, gzip.compress(json.dumps(d, separators=(",", ":")).encode("utf-8"), mtime=0))


def fetch_features(net, lay, ids=None):
    """Features as GeoJSON in WGS84 (by object id when ids is given), keyed by
    object id. Contact columns are never requested."""
    out = {}
    base = {"outFields": ",".join(lay["fields"]), "returnGeometry": "true", "outSR": 4326,
            "geometryPrecision": 6, "f": "geojson"}
    if ids is None:
        d = net.query(lay["url"], {**base, "where": "1=1"})
        chunks = [d]
    else:
        chunks = []
        ids = sorted(ids)
        for i in range(0, len(ids), 20):
            chunks.append(net.query(lay["url"], {**base, "objectIds": ",".join(map(str, ids[i:i + 20]))}))
    for d in chunks:
        for f in d.get("features", []):
            oid = f["properties"].get(lay["id"])
            f["id"] = oid
            out[oid] = f
    return out


def fetch_attrs(net, lay):
    rows, offset = [], 0
    while True:
        d = net.query(lay["url"], {"where": "1=1", "outFields": ",".join(lay["fields"]), "returnGeometry": "false",
                                   "orderByFields": lay["id"], "resultOffset": offset, "resultRecordCount": 1000, "f": "json"})
        feats = d.get("features", [])
        rows += [f["attributes"] for f in feats]
        if not feats or not d.get("exceededTransferLimit"):
            break
        offset += len(feats)
    return sorted(rows, key=lambda r: r[lay["id"]])


def cmd_fetch(a):
    net = Polite()
    for rel, url in DOWNLOADS.items():
        path = os.path.join(a.geo, rel)
        if os.path.exists(path):
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        print("fetch", url, flush=True)
        write_atomic(path, net.get(url, timeout=1800))
    os.makedirs(special_dir(a.geo), exist_ok=True)
    for key, lay in LAYERS.items():
        if lay.get("statewide"):
            p = attrs_path(a.geo, key)
            if not os.path.exists(p) or a.refresh:
                print("fetch attributes", key, flush=True)
                write_atomic(p, json.dumps(fetch_attrs(net, lay), ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        elif not os.path.exists(geom_path(a.geo, key)) or a.refresh:
            print("fetch layer", key, flush=True)
            write_geojson(geom_path(a.geo, key), fetch_features(net, lay))
    roster, _ = coverage_agencies(a.repo)
    counties = {norm_name(c) for c in CA_COUNTIES}
    for key in STATEWIDE:
        lay = LAYERS[key]
        want = needed_ids(key, read_attrs(a.geo, key), roster, counties)
        have = {} if a.refresh else read_geojson(geom_path(a.geo, key))
        missing = sorted(set(want) - set(have))
        print(f"{key}: {len(want)} features needed, {len(missing)} to fetch", flush=True)
        if missing:
            have.update(fetch_features(net, lay, missing))
            write_geojson(geom_path(a.geo, key), have)
    print("fetch done")


def read_attrs(geo, key):
    with open(attrs_path(geo, key), encoding="utf-8") as fh:
        return json.load(fh)


def curated_refs():
    out = collections.defaultdict(set)
    for sp in SPECIAL:
        for lay, nm in sp["refs"]:
            if lay in LAYERS:
                out[lay].add(nm)
    return out


def needed_ids(key, attrs, roster, county_keys):
    """Object ids whose geometry build needs: every feature a curated entry
    names, and every feature whose name matches a roster special agency."""
    lay = LAYERS[key]
    names = curated_refs().get(key, set())
    keys = {special_key(r["name"], county_keys) for r in roster if r["class"] == "special"}
    return sorted({r[lay["id"]] for r in attrs
                   if r.get(lay["name"]) in names or special_key(r.get(lay["name"]) or "", county_keys) in keys})


# ------------------------------------------------------------ release, roster, other names

CA_COUNTIES = [
    "Alameda", "Alpine", "Amador", "Butte", "Calaveras", "Colusa", "Contra Costa", "Del Norte", "El Dorado", "Fresno",
    "Glenn", "Humboldt", "Imperial", "Inyo", "Kern", "Kings", "Lake", "Lassen", "Los Angeles", "Madera", "Marin",
    "Mariposa", "Mendocino", "Merced", "Modoc", "Mono", "Monterey", "Napa", "Nevada", "Orange", "Placer", "Plumas",
    "Riverside", "Sacramento", "San Benito", "San Bernardino", "San Diego", "San Francisco", "San Joaquin",
    "San Luis Obispo", "San Mateo", "Santa Barbara", "Santa Clara", "Santa Cruz", "Shasta", "Sierra", "Siskiyou",
    "Solano", "Sonoma", "Stanislaus", "Sutter", "Tehama", "Trinity", "Tulare", "Tuolumne", "Ventura", "Yolo", "Yuba",
]


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def most_common(values):
    """Port of lib/model.js mostCommon: first seen wins a tie, except that a
    non-empty value beats an empty one."""
    counts = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    best, best_n = "", -1
    for v, c in counts.items():
        if c > best_n or (c == best_n and v and not best):
            best, best_n = v, c
    return best


def release_entities(root):
    """The viewer's entities: the exact receiving_entity string, with type and
    county the most common over each figure group's primary row."""
    rows = read_csv(os.path.join(root, "data", "reported-fee-collections.csv"))
    groups = collections.OrderedDict()
    for r in rows:
        groups.setdefault(r["figure_group_id"] or r["record_id"], []).append(r)
    ents = collections.OrderedDict()
    for rs in groups.values():
        prim = [r for r in rs if r["is_primary_in_figure_group"] == "true"]
        p = prim[0] if prim else rs[0]
        e = ents.setdefault(p["receiving_entity"], {"types": [], "counties": []})
        e["types"].append(p["entity_type"])
        e["counties"].append(p["county"])
    return [{"name": n, "type": most_common(e["types"]), "county": most_common(e["counties"])} for n, e in ents.items()]


def coverage_agencies(repo):
    with open(os.path.join(repo, "coverage", "coverage.json"), encoding="utf-8") as fh:
        d = json.load(fh)
    cols = d["columns"]
    out = []
    for a in d["agencies"]:
        r = dict(zip(cols, a))
        out.append({"name": r["name"], "class": d["classes"][r["class"]]["key"], "type": d["types"][r["type"]],
                    "county": d["counties"][r["county"]], "release_names": r.get("release_names") or []})
    return out, {"written_utc": d.get("written_utc"), "release_commit": d.get("release_commit")}


def other_names(root, repo):
    """Every other name a viewer tab joins on, as {name, type, county, view,
    linked}. A sources index row has no type, so linked holds the names of
    the release rows that cite the same source document."""
    out = []
    cites = collections.defaultdict(set)
    for fn in ("reported-fee-collections.csv", "fee-account-figures.csv"):
        p = os.path.join(root, "data", fn)
        if not os.path.exists(p):
            continue
        rows = read_csv(p)
        for r in rows:
            for col in ("source_id", "source_pdf"):
                if r.get(col):
                    cites[(col, r[col])].add(r["receiving_entity"])
        if fn == "fee-account-figures.csv":
            seen = set()
            for r in rows:
                k = (r["receiving_entity"], r["entity_type"], r["county"])
                if k not in seen:
                    seen.add(k)
                    out.append({"name": k[0], "type": k[1], "county": k[2], "view": "funds", "linked": set()})
    p = os.path.join(root, "data", "fee-schedules.csv")
    if os.path.exists(p):
        seen = set()
        for r in read_csv(p):
            k = (r.get("receiving_entity") or r.get("agency", ""), r.get("entity_type", ""), r.get("county", ""))
            if k not in seen:
                seen.add(k)
                out.append({"name": k[0], "type": k[1], "county": k[2], "view": "schedules", "linked": set()})
    p = os.path.join(root, "sources", "index.csv")
    if os.path.exists(p):
        linked = collections.defaultdict(set)
        for r in read_csv(p):
            for col in ("source_id", "source_pdf"):
                if r.get(col):
                    linked[r["receiving_entity"]] |= cites.get((col, r[col]), set())
        for n in sorted(linked):
            out.append({"name": n, "type": "", "county": "", "view": "sources", "linked": linked[n] - {n}})
    return out


def apr_jurisdictions(repo):
    with open(os.path.join(repo, "apr", "apr.json"), encoding="utf-8") as fh:
        d = json.load(fh)
    return [dict(zip(d["jurisdiction_columns"], j)) for j in d["jurisdictions"]]


# ------------------------------------------------------------ geometry

def geo_libs():
    global np, shapely, shapefile, shape_of, Transformer
    import numpy as np
    import shapely
    import shapefile
    from shapely.geometry import shape as shape_of
    from pyproj import Transformer


def clean(g):
    return g if g.is_valid else shapely.make_valid(g)


def read_zip_shapes(path, keep):
    z = zipfile.ZipFile(path)
    base = next(n for n in z.namelist() if n.endswith(".dbf"))[:-4]
    r = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), shx=io.BytesIO(z.read(base + ".shx")),
                         dbf=io.BytesIO(z.read(base + ".dbf")), encoding="utf-8")
    picked = [(i, rec.as_dict()) for i, rec in enumerate(r.iterRecords()) if keep(rec.as_dict())]
    return [(rec, clean(shape_of(r.shape(i).__geo_interface__))) for i, rec in picked]


class Geo:
    """TIGER layers, 2020 block points with their Commission districts, and
    the overlap of any agency footprint with the districts."""

    def __init__(self, geo):
        self.dir = geo
        tf = Transformer.from_crs("EPSG:4269", "EPSG:3310", always_xy=True)
        self.proj = lambda g: shapely.transform(g, lambda xy: np.column_stack(tf.transform(xy[:, 0], xy[:, 1])))
        t = lambda f: os.path.join(geo, "tiger2026", f)
        self.sld = {}
        for ch, fn, fld in (("ad", "tl_2026_06_sldl.zip", "SLDLST"), ("sd", "tl_2026_06_sldu.zip", "SLDUST")):
            rows = read_zip_shapes(t(fn), lambda r: True)
            nums = [int(r[fld]) for r, _ in rows]
            proj = [self.proj(g) for _, g in rows]
            self.sld[ch] = {"n": nums, "p": proj, "tree": shapely.STRtree(proj)}
        self.feats = {}
        self.pop_outside = 0
        self.area_added = 0
        # Incorporated places only: CDPs are not agencies.
        layers = (("place", "tl_2026_06_place.zip", lambda r: r["CLASSFP"] == "C1"), ("county", "tl_2026_us_county.zip", lambda r: r["STATEFP"] == "06"),
                  ("unsd", "tl_2026_06_unsd.zip", lambda r: True), ("elsd", "tl_2026_06_elsd.zip", lambda r: True),
                  ("scsd", "tl_2026_06_scsd.zip", lambda r: True))
        for layer, fn, keep in layers:
            out = []
            for rec, g in read_zip_shapes(t(fn), keep):
                out.append({"layer": layer, "geoid": rec["GEOID"], "name": rec["NAME"], "namelsad": rec.get("NAMELSAD", rec["NAME"]),
                            "classfp": rec.get("CLASSFP", ""), "sdtyp": rec.get("SDTYP", ""), "funcstat": rec.get("FUNCSTAT", ""),
                            "countyfp": rec.get("COUNTYFP", ""), "geo": g, "p": self.proj(g), "counties": []})
            self.feats[layer] = out
        self.by_id = {(f["layer"], f["geoid"]): f for lay in self.feats.values() for f in lay}
        self.county_by_fp = {f["countyfp"]: f["name"] for f in self.feats["county"]}
        self.load_blocks()
        self.assign_counties()
        self.place_blocks()

    def load_blocks(self):
        ids, pops, lon, lat = [], [], [], []
        z = zipfile.ZipFile(os.path.join(self.dir, "pl2020", "ca2020.pl.zip"))
        with z.open("cageo2020.pl") as fh:
            for line in io.TextIOWrapper(fh, encoding="latin-1"):
                f = line.split("|")
                if f[2] != "750":
                    continue
                # tail of the geoheader: ... POP100, HU100, INTPTLAT, INTPTLON, LSADC, PARTFLAG, UGA
                ids.append(f[9])  # GEOCODE, the 15 digit block GEOID
                pops.append(int(f[-7]))
                lat.append(float(f[-5]))
                lon.append(float(f[-4]))
        self.block_ids = ids
        self.pop = np.array(pops, dtype=np.int64)
        self.lon = np.array(lon)
        self.lat = np.array(lat)
        self.points = shapely.points(self.lon, self.lat)
        self.block_county = np.array([self.county_by_fp.get(b[2:5], "") for b in ids], dtype=object)
        self.equiv = {}
        for ch, fn in (("ad", "2021_AD_Final_equiv.zip"), ("sd", "2021_SD_Final_equiv.zip")):
            z = zipfile.ZipFile(os.path.join(self.dir, "swdb2021", fn))
            name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
            eq = {}
            with z.open(name) as fh:
                for row in csv.reader(io.TextIOWrapper(fh, encoding="latin-1")):
                    eq[row[0].strip('"')] = int(row[1].strip('"'))
            arr = np.array([eq.get(b, 0) for b in ids], dtype=np.int64)
            if (arr == 0).any():
                raise SystemExit(f"{fn}: {(arr == 0).sum()} blocks have no district")
            self.equiv[ch] = arr

    def assign_counties(self):
        """Counties each place and school feature overlaps by more than
        1000 m2 (TIGER place and school files carry no county)."""
        cty = self.feats["county"]
        tree = shapely.STRtree([c["p"] for c in cty])
        for layer in ("place", "unsd", "elsd", "scsd"):
            for f in self.feats[layer]:
                hits = []
                area = f["p"].area or 1.0
                for i in tree.query(f["p"]):
                    a = f["p"].intersection(cty[int(i)]["p"]).area
                    if a > 1000:
                        hits.append((a / area, cty[int(i)]["name"]))
                hits.sort(reverse=True)
                f["counties"] = [n for _, n in hits]
        for c in cty:
            c["counties"] = [c["name"]]

    def place_blocks(self):
        """Block interior points inside each TIGER feature."""
        for layer, feats in self.feats.items():
            tree = shapely.STRtree([f["geo"] for f in feats])
            pi, gi = tree.query(self.points, predicate="within")
            order = np.argsort(gi, kind="stable")
            pi, gi = pi[order], gi[order]
            bounds = np.searchsorted(gi, np.arange(len(feats) + 1))
            for k, f in enumerate(feats):
                f["blocks"] = pi[bounds[k]:bounds[k + 1]]

    def blocks_in(self, g):
        """Block interior points inside a geographic polygon."""
        x0, y0, x1, y1 = g.bounds
        m = np.nonzero((self.lon >= x0) & (self.lon <= x1) & (self.lat >= y0) & (self.lat <= y1))[0]
        if not len(m):
            return m
        shapely.prepare(g)
        return m[shapely.contains_xy(g, self.lon[m], self.lat[m])]

    def overlap(self, p, blocks, rule):
        """Districts for one footprint. p is the projected polygon, blocks
        the block indices inside it. rule 'area' counts every district the
        polygon overlaps by at least 1 m2, and only those: a 2020 block of a
        neighbouring county whose interior point now falls inside the 2026
        polygon does not add a district the polygon never reaches. rule
        'blocks', for layers whose edges do not follow TIGER, counts the
        districts of the blocks inside, plus any district the polygon still
        overlaps once shrunk by INSET_M, by at least INSET_MIN_M2 or
        INSET_MIN_SHARE of its area, so a part holding no block interior
        point is not lost. Shares are of the residents in the districts
        listed."""
        area = p.area
        pop = int(self.pop[blocks].sum()) if len(blocks) else 0
        floor = min(INSET_MIN_M2, INSET_MIN_SHARE * area)
        inner = None
        out = {}
        for ch, s in self.sld.items():
            areas = collections.Counter()
            hits = collections.defaultdict(list)
            for i in s["tree"].query(p, predicate="intersects"):
                a = p.intersection(s["p"][int(i)]).area
                if a > 0:
                    areas[s["n"][int(i)]] += a
                    hits[s["n"][int(i)]].append(int(i))
            pop_by = collections.Counter()
            blk_by = collections.Counter()
            for d, w in zip(self.equiv[ch][blocks].tolist(), self.pop[blocks].tolist()):
                pop_by[d] += w
                blk_by[d] += 1
            if rule == "area":
                ds = {d for d, a in areas.items() if a >= 1.0}
                # Residents the equivalency puts in a district the polygon
                # does not reach: left out, and counted for the report.
                self.pop_outside += sum(1 for d, w in pop_by.items() if w > 0 and d not in ds)
            else:
                ds = set(blk_by)
                for d, a in sorted(areas.items()):
                    if d in ds or a < floor:
                        continue
                    if inner is None:
                        inner = clean(p.buffer(-INSET_M))
                    if inner.is_empty:
                        break
                    if sum(inner.intersection(s["p"][i]).area for i in hits[d]) >= floor:
                        ds.add(d)
                        self.area_added += 1
            weights = {d: pop_by.get(d, 0) for d in ds}
            listed = sum(weights.values())
            shares = largest_remainder(weights, listed) if listed else {d: None for d in ds}
            rows = [(d, shares[d], int(round(1000 * areas.get(d, 0.0) / area)) if area else 0) for d in ds]
            rows.sort(key=lambda r: (-(r[1] if r[1] is not None else -1), r[0]))
            out[ch] = rows
        return out, pop

    def point_district(self, p):
        """Fallback for a footprint holding no block point: the district
        containing its representative point."""
        q = p.representative_point()
        out = {}
        for ch, s in self.sld.items():
            hits = [s["n"][int(i)] for i in s["tree"].query(q, predicate="within")]
            out[ch] = [(d, None, 1000) for d in sorted(hits)]
        return out


# The area test of rule 'blocks': a special district's polygon, shrunk by
# INSET_M so a layer's misalignment with TIGER does not count, must still
# overlap the district by INSET_MIN_M2, or by INSET_MIN_SHARE of its own area
# when that is smaller.
INSET_M = 50.0
INSET_MIN_M2 = 10_000.0
INSET_MIN_SHARE = 0.005


def largest_remainder(weights, total):
    """Shares in thousandths that sum to exactly 1000."""
    exact = {d: 1000 * w / total for d, w in weights.items()}
    floor = {d: int(v) for d, v in exact.items()}
    left = 1000 - sum(floor.values())
    for d in sorted(exact, key=lambda d: (-(exact[d] - floor[d]), d))[:max(left, 0)]:
        floor[d] += 1
    return floor


# ------------------------------------------------------------ TIGER matching (port of the name-matching prototype)

class Index:
    def __init__(self, feats):
        self.place = collections.defaultdict(list)
        self.county = {}
        self.sd = collections.defaultdict(list)
        self.pseudo = collections.defaultdict(list)
        self.sd_full_list = []
        for f in feats["place"]:
            for k in paren_variants(f["name"]):
                self.place[k].append(f)
        for f in feats["county"]:
            self.county[norm_tokens(f["name"])] = f
        for layer in ("unsd", "elsd", "scsd"):
            for f in feats[layer]:
                if f["funcstat"] == "F" and f["sdtyp"] != "A":
                    continue  # 'School District Not Defined'
                if f["sdtyp"] == "A":
                    self.pseudo[sd_full(f["name"])].append(f)
                    continue
                self.sd_full_list.append((sd_full(f["name"]), f))
                for t, ks in sd_keys(f["name"])[0].items():
                    for k in ks:
                        self.sd[(t, k)].append(f)
        self.by_name = {(f["layer"], f["name"]): f for lay in feats.values() for f in lay}


def in_county(f, counties):
    if not counties or not f["counties"]:
        return True
    return any(c in f["counties"] for c in counties)


def match_place(name, etype, counties, idx):
    if SF_NAMES.match(name.strip()):
        return [idx.place["SAN FRANCISCO"][0], idx.county["SAN FRANCISCO"]], "sf"
    base = place_base(name)
    if not base or etype not in PLACE_TYPES:
        return None
    keys = paren_variants(base)
    nb = norm_tokens(base)
    if nb == "AMADOR" and "Amador" in counties:
        keys.append("AMADOR CITY")  # also the county's name
    if nb in PLACE_ALIASES:
        keys.append(PLACE_ALIASES[nb])
    for k in keys:
        cands = idx.place.get(k, [])
        if not cands:
            continue
        here = [f for f in cands if in_county(f, counties)]
        if len(here) == 1:
            if here[0]["geoid"] == "0667000":
                return [here[0], idx.county["SAN FRANCISCO"]], "sf"
            return here, "place"
        return [], "ambiguous" if here else "county_differs"
    return [], "unmatched"


def match_county(name, etype, counties, idx):
    base = county_base(name)
    if not base or etype not in COUNTY_TYPES:
        return None
    f = idx.county.get(norm_tokens(base))
    if not f:
        return [], "unmatched"
    if counties and f["name"] not in counties:
        return [], "county_differs"
    if f["name"] == "San Francisco":
        return [idx.place["SAN FRANCISCO"][0], f], "sf"
    return [f], "county"


def with_pseudo(f, idx):
    """A district's footprint also takes the pseudo secondary parts TIGER
    files under its name in SCSD: territory where it is the high school
    district only, often in another county. When two districts share the
    name, a part goes to the one sharing its county."""
    key = sd_full(f["name"])
    parts = idx.pseudo.get(key, [])
    if len([g for k, g in idx.sd_full_list if k == key]) > 1:
        parts = [p for p in parts if f["counties"] and set(p["counties"]) & set(f["counties"])]
    return [f] + parts


def match_school(name, etype, counties, idx):
    if etype not in SCHOOL_TYPES:
        return None
    nt = norm_tokens(name)
    manual = SD_MANUAL.get(nt)
    if manual:
        hits = [idx.by_name[k] for k in manual if k in idx.by_name]
        if hits:
            return hits, "manual"
    for c in counties or [""]:
        rn = SD_RENAMES.get((nt, c))
        if rn and rn in idx.by_name:
            return with_pseudo(idx.by_name[rn], idx), "rename"
    fam, name_levels = sd_keys(name)
    type_level = TYPE_LEVEL.get(etype)
    levels = {type_level} if type_level else (name_levels or {"unsd", "elsd", "scsd"})
    if type_level and name_levels and type_level not in name_levels:
        levels = name_levels | {type_level}
    problem = None
    for tier in SD_FAMILIES:
        cands = []
        for k in sorted(fam.get(tier, ())):
            cands += [f for f in idx.sd.get((tier, k), []) if f not in cands]
        if tier == "core":
            cands = [f for f in cands if f["layer"] in levels]
        if not cands:
            continue
        lv = [f for f in cands if f["layer"] in levels] or cands
        here = [f for f in lv if in_county(f, counties)]
        if len(here) > 1 and not type_level and not name_levels:
            # 'X Union School District' with no level word is the CDE style
            # for an elementary district.
            el = [f for f in here if f["layer"] == "elsd"]
            if len(el) == 1:
                here = el
        if len(here) == 1:
            return with_pseudo(here[0], idx), tier
        if problem is None:
            problem = "ambiguous" if here else "county_differs"
    if len(name) == 30 and not problem:  # CDE cuts names at 30 characters
        pre = " ".join(sd_tokens(name))
        cands = [f for k, f in idx.sd_full_list if k.startswith(pre) and f["layer"] in levels and in_county(f, counties)]
        if len(cands) == 1:
            return with_pseudo(cands[0], idx), "truncated"
        problem = "ambiguous" if cands else None
    return [], problem or "unmatched"


def match_one(name, etype, counties, idx):
    """TIGER features for a city, county or school district name, gated by
    entity type; None when the type has no TIGER layer."""
    for fn in (match_place, match_county, match_school):
        r = fn(name, etype, counties, idx)
        if r is not None:
            return r
    return None


def fs_key(feats):
    return tuple(sorted((f["layer"], f["geoid"]) for f in feats))


# ------------------------------------------------------------ special district geometry

class Special:
    def __init__(self, geo, g):
        self.g = g
        self.feats = {}
        self.placeholders = []
        for key, lay in LAYERS.items():
            for oid, f in read_geojson(geom_path(geo, key)).items():
                if not f.get("geometry"):
                    continue
                shp = clean(shape_of(f["geometry"]))
                if shp.is_empty:
                    continue
                p = clean(g.proj(shp))
                name = f["properties"].get(lay["name"]) if lay["name"] else lay["label"]
                if p.area < 100:
                    # CSDA marks a district it has no boundary for with a
                    # polygon of a square meter or two; that is no boundary.
                    self.placeholders.append(f"{key} {oid}: {name}")
                    continue
                self.feats[(key, oid)] = {"layer": key, "id": oid, "props": f["properties"], "name": name,
                                          "geo": shp, "p": p}
        self._blocks = {}

    def by_name(self, layer, name):
        return sorted((f for (lay, _), f in self.feats.items() if lay == layer and (name is None or f["name"] == name)),
                      key=lambda f: f["id"])

    def blocks(self, f):
        k = (f["layer"], f["id"])
        if k not in self._blocks:
            self._blocks[k] = self.g.blocks_in(f["geo"])
        return self._blocks[k]

    def counties(self, f):
        """Counties holding a quarter or more of the feature's blocks; the
        county of its representative point when it holds none."""
        b = self.blocks(f)
        if len(b):
            c = collections.Counter(self.g.block_county[b].tolist())
            return {k for k, v in c.items() if v >= 0.25 * len(b)}
        q = f["geo"].representative_point()
        return {c["name"] for c in self.g.feats["county"] if c["geo"].contains(q)}


# ------------------------------------------------------------ build

BASES = ["boundary", "district_boundary", "same_as", "approximate", "unmapped"]
CLASSES = ["municipal", "school", "special"]


def class_of(etype):
    if etype in PLACE_TYPES | COUNTY_TYPES and etype:
        return "municipal"
    if etype in SCHOOL_TYPES:
        return "school"
    return "special"


def cmd_build(a):
    geo_libs()
    t0 = time.time()
    g = Geo(a.geo)
    print(f"geometry loaded in {time.time() - t0:.0f}s", flush=True)
    idx = Index(g.feats)
    sp = Special(a.geo, g)
    county_keys = {norm_name(c) for c in CA_COUNTIES}
    roster, cov_meta = coverage_agencies(a.repo)
    release = release_entities(a.data_root)
    report = collections.defaultdict(list)
    cache = {}

    def evaluate(feats, rule):
        """Districts for TIGER features (rule 'area') or special district
        pieces (rule 'blocks'), cached by footprint."""
        key = (rule, tuple(sorted((f["layer"], f.get("geoid", f.get("id"))) for f in feats)))
        if key in cache:
            return cache[key]
        if rule == "area":
            p = feats[0]["p"] if len(feats) == 1 else shapely.union_all([f["p"] for f in feats])
            blocks = np.unique(np.concatenate([f["blocks"] for f in feats]))
        else:
            parts = []
            for f in feats:
                if "p" not in f:
                    f["p"] = clean(g.proj(f["geo"]))
                parts.append(f["p"])
            p = clean(shapely.union_all(parts))
            blocks = np.unique(np.concatenate([sp.blocks(f) if "id" in f else f["blocks"] for f in feats]))
        res, pop = g.overlap(p, blocks, rule)
        fallback = False
        # No block inside and too small for the area test: the district
        # holding its interior point.
        if rule == "blocks" and not len(blocks) and not all(res.values()):
            res, fallback = g.point_district(p), True
        cache[key] = (res, pop, fallback)
        return cache[key]

    records = {}  # key -> record

    def add_record(key, name, etype, county, cls, basis, note, feats, rule, roster_row, sources_row=None):
        if basis == "unmapped":
            res, pop, fb = {"ad": [], "sd": []}, 0, False
        else:
            res, pop, fb = evaluate(feats, rule)
        if fb:
            note = (note + " " if note else "") + "No 2020 census block lies inside; placed by its interior point."
            report["placed_by_point"].append(name)
        r = {"key": key, "name": name, "type": etype, "county": county, "class": cls, "basis": basis, "note": note,
             "ad": res["ad"], "sd": res["sd"], "release": set(), "roster": roster_row, "pop": pop, "src": sources_row}
        records[key] = r
        return r

    def rkey(name, etype, county):
        return f"{name}|{etype}|{county}"

    # --- roster: cities, counties, school districts, offices of education
    roster_fs = collections.defaultdict(list)  # TIGER footprint -> roster keys
    roster_by_key = {}
    tally = collections.defaultdict(collections.Counter)
    county_feat = {f["name"]: f for f in g.feats["county"]}
    for ag in roster:
        k = rkey(ag["name"], ag["type"], ag["county"])
        roster_by_key[k] = ag
        counties = split_counties(ag["county"])
        cls = ag["class"]
        tally[cls]["total"] += 1
        if cls == "municipal" or (cls == "school" and ag["type"] in GEO_SCHOOL):
            r = match_one(ag["name"], ag["type"], counties, idx)
            feats, how = r if r else ([], "no_layer")
            if not feats:
                tally[cls]["unmatched_" + how] += 1
                report[f"roster_{cls}_unmatched"].append(f'{ag["name"]} [{ag["type"]}; {ag["county"]}] {how}')
                continue
            add_record(k, ag["name"], ag["type"], ag["county"], cls, "boundary", "", feats, "area", True)
            roster_fs[fs_key(feats)].append(k)
            tally[cls]["boundary"] += 1
        elif cls == "school" and ag["type"] == "county_office_of_education":
            cn = next((c for c in counties if c in county_feat), None)
            if cn is None:
                m = re.match(r"^(.+?) County Office of Education$", ag["name"])
                cn = m.group(1) if m and m.group(1) in county_feat else None
            if cn is None:
                tally[cls]["unmatched_coe"] += 1
                report["roster_coe_unmatched"].append(ag["name"])
                continue
            feats = [county_feat[cn]] + ([idx.place["SAN FRANCISCO"][0]] if cn == "San Francisco" else [])
            add_record(k, ag["name"], ag["type"], ag["county"], cls, "same_as", f"Same boundary as {cn} County.",
                       feats, "area", True, {"source": TIGER_LABEL + " COUNTY", "url": DOWNLOADS["tiger2026/tl_2026_us_county.zip"],
                                             "feature": f"{county_feat[cn]['geoid']} {county_feat[cn]['namelsad']}"})
            tally[cls]["same_as"] += 1
        elif cls == "school":
            tally[cls]["no_layer"] += 1

    # --- release names
    rel_to_roster = collections.defaultdict(list)
    for ag in roster:
        for rn in ag["release_names"]:
            rel_to_roster[rn].append(rkey(ag["name"], ag["type"], ag["county"]))
    curated = {}
    for s in SPECIAL:
        for n in s["names"]:
            curated[n] = s
    release_link = {}  # release name -> record key
    special_done = {}  # id(spec) -> record key
    def place_special(name, etype, county, counties):
        """The record for a curated entry, made once however many of its
        names appear."""
        s = curated[name]
        if id(s) in special_done:
            return special_done[id(s)]
        # The roster row the entry names, else the one coverage links to any
        # of its names, else an exact normalized name in the same county.
        # Only special rows: a city's row never takes a special district's
        # footprint.
        free = lambda c: roster_by_key[c]["class"] == "special" and c not in records
        if s["roster"]:
            rk = sorted(c for c in roster_by_key if c.split("|")[0] == s["roster"] and free(c))
        else:
            rk = sorted({c for n in s["names"] for c in rel_to_roster.get(n, []) if free(c)})
        if not rk and not s["roster"]:
            sk = special_key(name, county_keys)
            rk = sorted(rkey(ag["name"], ag["type"], ag["county"]) for ag in roster
                        if special_key(ag["name"], county_keys) == sk and free(rkey(ag["name"], ag["type"], ag["county"]))
                        and (not counties or set(split_counties(ag["county"])) & set(counties)))
        if s["roster"] and not rk:
            raise SystemExit(f"{name}: roster row {s['roster']!r} not found")
        if len(rk) > 1:
            report["special_several_roster"].append(f"{name} -> {rk}")
        if rk:
            ag = roster_by_key[rk[0]]
            k, nm, et, cn, on_roster = rk[0], ag["name"], ag["type"], ag["county"], True
        else:
            k, nm, et, cn, on_roster = rkey(name, etype, county), name, etype, county, False
            report["special_not_on_roster"].append(name)
        feats, srow = special_feats(s, sp, idx, g)
        if s["basis"] != "unmapped" and not feats:
            raise SystemExit(f"{name}: no feature found for {s['refs']}; run fetch")
        tiger_only = all("geoid" in f for f in feats)
        note = s["note"] or ("Counted by 2020 census blocks." if s["basis"] == "district_boundary" else "")
        add_record(k, nm, et, cn, "special", s["basis"], note, feats, "area" if tiger_only else "blocks", on_roster, srow)
        special_done[id(s)] = k
        return k

    for e in release:
        name = e["name"]
        counties = split_counties(e["county"])
        linked = rel_to_roster.get(name, [])
        if not counties and len(linked) == 1:
            counties = split_counties(roster_by_key[linked[0]]["county"])
        elif not counties and name in RELEASE_COUNTY_HINTS:
            counties = [RELEASE_COUNTY_HINTS[name]]
        r = match_one(name, e["type"], counties, idx) if name not in curated else None
        if r is not None:
            feats, how = r
            if not feats:
                report["release_unmatched_in_scope"].append(f'{name} [{e["type"]}; {e["county"]}] {how}')
                continue
            cands = roster_fs.get(fs_key(feats), [])
            if len(cands) > 1:
                # Roster duplicates share a footprint: take the one coverage
                # links to this name, else the one with the same name key,
                # else the first.
                pref = ([c for c in cands if c in linked]
                        or [c for c in cands if sd_full(roster_by_key[c]["name"]) == sd_full(name)] or sorted(cands))
                report["release_shared_footprint"].append(f"{name} -> {', '.join(sorted(cands))}; took {pref[0]}")
                cands = pref[:1]
            if cands:
                release_link[name] = cands[0]
            else:
                k = rkey(name, e["type"], e["county"])
                if k not in records:
                    add_record(k, name, e["type"], e["county"], class_of(e["type"]), "boundary", "", feats, "area", False)
                release_link[name] = k
                report["release_only_records"].append(name)
            continue
        if name not in curated:
            report["release_unmapped_no_entry"].append(f'{name} [{e["type"]}; {e["county"]}]')
            continue
        release_link[name] = place_special(name, e["type"], e["county"], counties)

    # Curated names that only the Funds tab uses.
    extra = other_names(a.data_root, a.repo)
    for o in extra:
        if o["name"] in curated and o["name"] not in release_link:
            place_special(o["name"], o["type"], o["county"], split_counties(o["county"]))

    # --- roster special districts: conservative automatic match
    claimed = {k for k in records}
    layer_index = {}
    for key in STATEWIDE:
        ix = collections.defaultdict(list)
        for (lay, oid), f in sp.feats.items():
            if lay == key and f["name"]:
                ix[special_key(f["name"], county_keys)].append(f)
        layer_index[key] = ix
    claims = collections.defaultdict(list)
    for ag in roster:
        if ag["class"] != "special":
            continue
        k = rkey(ag["name"], ag["type"], ag["county"])
        if k in claimed:
            tally["special"]["release_entry"] += 1
            continue
        counties = set(split_counties(ag["county"]))
        sk = special_key(ag["name"], county_keys)
        if not counties or not sk:
            tally["special"]["unmapped_no_county"] += 1
            continue
        hit, why = None, "unmapped_no_name_match"
        for key in STATEWIDE:
            cands = sorted(layer_index[key].get(sk, []), key=lambda f: f["id"])
            if not cands:
                continue
            if key == "calfire":
                seeds = [f for f in cands if norm_name(f["props"].get("County")) in {norm_name(c) for c in counties}]
            else:
                seeds = [f for f in cands if sp.counties(f) & counties]
            if not seeds:
                why = "unmapped_county_differs"
                continue
            # A polygon holding no 2020 block point is usually a parcel or a
            # misplaced shape, not the district; leave the agency unmapped.
            if not any(len(sp.blocks(f)) for f in seeds):
                why = "unmapped_no_block_inside"
                report["special_auto_no_block"].append(f'{ag["name"]} [{ag["county"]}] {key}')
                continue
            # Pieces of the same name in a neighbouring county join the seed.
            seed = shapely.union_all([f["p"] for f in seeds])
            more = [f for f in cands if f not in seeds and seed.distance(f["p"]) <= 200]
            hit = (key, seeds + more)
            break
        if not hit:
            tally["special"][why] += 1
            continue
        key, feats = hit
        lay = LAYERS[key]
        feats.sort(key=lambda f: f["id"])
        srow = {"source": lay["label"], "url": lay["url"],
                "feature": "; ".join(f'{lay["id"]} {f["id"]}: {f["name"]}' + (f' ({f["props"].get("County")})' if key == "calfire" else "")
                                     for f in feats)}
        add_record(k, ag["name"], ag["type"], ag["county"], "special", "district_boundary",
                   "Matched by exact name and county; counted by 2020 census blocks.", feats, "blocks", True, srow)
        for f in feats:
            claims[(key, f["id"])].append(ag["name"])
        tally["special"]["auto_" + key] += 1
    for fk, names in sorted(claims.items(), key=lambda kv: str(kv[0])):
        if len(names) > 1:
            report["special_feature_claimed_twice"].append(f"{fk}: {names}")

    # --- link release names; other names the tabs use
    for name, k in release_link.items():
        records[k]["release"].add(name)
    names = collections.defaultdict(set)  # name -> record keys
    for k, r in records.items():
        names[r["name"]].add(k)
        for n in r["release"]:
            names[n].add(k)
    for n, ks in names.items():
        if n in release_link and ks != {release_link[n]}:
            report["release_name_conflict"].append(f"{n}: {sorted(ks)}")
    aliases = collections.defaultdict(set)

    def pick(ks, etype, county):
        """One record key out of several sharing a name, by type then county."""
        ks = sorted(ks)
        if len(ks) > 1 and etype:
            ks = [k for k in ks if records[k]["type"] == etype] or ks
        if len(ks) > 1 and county:
            cs = set(split_counties(county))
            ks = [k for k in ks if cs & set(split_counties(records[k]["county"]))] or ks
        return ks[0] if len(ks) == 1 else None

    def resolve(o):
        """Record key for a name another tab uses: the TIGER footprint of a
        city, county or school district name gated by its type, else the
        record of the release rows citing the same source."""
        r = match_one(o["name"], o["type"], split_counties(o["county"]), idx) if o["type"] else None
        if r and r[0]:
            cands = roster_fs.get(fs_key(r[0]), [])
            if cands:
                return pick(cands, o["type"], o["county"])
        ks = {k for n in o["linked"] for k in names.get(n, ())}
        return pick(ks, "", "") if ks else None

    for o in extra:
        view = "names_" + o["view"]
        ks = names.get(o["name"])
        if ks:
            if pick(ks, o["type"], o["county"]) is None:
                tally[view]["ambiguous"] += 1
                report[f'{o["view"]}_ambiguous'].append(f'{o["name"]} [{o["type"]}; {o["county"]}]')
            else:
                tally[view]["exact"] += 1
            continue
        k = resolve(o)
        if k:
            aliases[o["name"]].add(k)
            tally[view]["alias"] += 1
        else:
            tally[view]["unresolved"] += 1
            report[f'{o["view"]}_unresolved'].append(f'{o["name"]} [{o["type"]}; {o["county"]}]')
    for j in apr_jurisdictions(a.repo):
        k = rkey(j["agency"], *next(((ag["type"], ag["county"]) for ag in roster
                                     if ag["name"] == j["agency"] and ag["class"] == "municipal"), ("", "")))
        if k not in records:
            report["apr_unresolved"].append(j["juris_name"])
            continue
        tally["names_apr"]["mapped"] += 1
        if j["juris_name"] not in names:
            aliases[j["juris_name"]].add(k)
    # Every spelling of a city or county name the viewer could meet.
    for k, r in records.items():
        if r["class"] != "municipal" or not r["roster"]:
            continue
        for form in municipal_forms(r["name"]):
            if form not in names and form not in aliases:
                aliases[form].add(k)
    for n, ks in list(aliases.items()):
        if len(ks) > 1:
            report["alias_ambiguous"].append(f"{n}: {sorted(ks)}")

    report["pairs_left_out_residents_outside_polygon"] = [str(g.pop_outside)]
    report["pairs_added_by_area_without_blocks"] = [str(g.area_added)]
    write_outputs(a, g, records, aliases, roster, release, release_link, tally, report, cov_meta)
    print(f"built in {time.time() - t0:.0f}s", flush=True)


def municipal_forms(name):
    if name == "City and County of San Francisco":
        return ["San Francisco", "San Francisco city", "City of San Francisco", "San Francisco County", "County of San Francisco",
                "City & County of San Francisco"]
    m = re.match(r"^(.+) County$", name)
    if m:
        return [f"County of {m.group(1)}"]
    m = re.match(r"^(.+) (city|town)$", name)
    if not m:
        return []
    word = m.group(2).capitalize()
    p = re.match(r"^(.+?) \((.+)\)$", m.group(1))
    bases = [m.group(1)] + ([p.group(1), p.group(2)] if p else [])
    out = []
    for b in bases:
        out += [f"{word} of {b}", f"{b} {m.group(2)}"]
    return [x for x in out if x != name]


def special_feats(s, sp, idx, g):
    """Features for a curated entry, and its sources.csv fields."""
    feats, parts = [], []
    for lay, nm in s["refs"]:
        if lay in LAYERS:
            fs = sp.by_name(lay, nm)
            if not fs:
                return [], None
            feats += fs
            L = LAYERS[lay]
            parts.append((L["label"], L["url"], "; ".join(f'{L["id"]} {f["id"]}' + (f': {f["name"]}' if L["name"] and f["name"] and L.get("show_name", True) else "")
                                                          + (f' ({f["props"].get("County")})' if lay == "calfire" else "") for f in fs)))
        else:
            if lay == "place":
                f = next((f for f in idx.place.get(norm_tokens(nm), []) if f["classfp"] == "C1"), None)
            elif lay == "county":
                f = idx.county.get(norm_tokens(nm))
            else:
                f = idx.by_name.get((lay, nm))
            if f is None:
                raise SystemExit(f"TIGER {lay} {nm} not found")
            feats.append(f)
            parts.append((f"{TIGER_LABEL} {lay.upper()}", DOWNLOADS[f"tiger2026/tl_2026_{'us' if lay == 'county' else '06'}_{lay}.zip"],
                          f'{f["geoid"]} {f["namelsad"]}'))
    if not parts:
        return feats, {"source": "", "url": "", "feature": ""}
    return feats, {"source": " + ".join(sorted({p[0] for p in parts})), "url": " ".join(sorted({p[1] for p in parts})),
                   "feature": "; ".join(p[2] for p in parts)}


# ------------------------------------------------------------ output

PLAN = "2021 Citizens Redistricting Commission maps (Assembly and Senate), in effect from the 2022 election"
PLAN_NOTE = ("Fiscal years before 2022-23 were collected while the 2011 maps were in force; the filter always uses the "
             "current 2021 maps. Senate terms are staggered, and every Senate seat has been elected on the 2021 map "
             "since the 2024 election.")
CAVEAT = ("An agency counts in an Assembly or Senate district when at least 1% of its 2020 residents live there (an "
          "agency with no residents counts in every district its territory reaches); districts it touches with fewer "
          "residents are shown as edge contacts but left out of filters and totals, and many agencies still count in "
          "more than one district, so district totals overlap.")
SOURCE = ("District boundaries: Census TIGER/Line 2026 state legislative districts, which match the Commission's final "
          "maps. Agency boundaries: TIGER/Line 2026 incorporated places, counties and school districts; CAL FIRE, CSDA, "
          "DWR and county layers for special districts (see legislative/sources.csv). Population: 2020 census blocks "
          "(PL 94-171) with the Commission's block equivalency files (Statewide Database copies).")
METHOD = ("A city, county or school district counts in a district when their TIGER polygons overlap by at least 1 square "
          "meter in California Albers (EPSG:3310); polygons that only share an edge do not count. A special district "
          "counts in a district when a 2020 census block whose interior point lies inside its polygon belongs to that "
          "district, or when its polygon, shrunk by 50 meters because those layers do not share TIGER's edges, still "
          "overlaps the district by 10,000 square meters or by 0.5% of its area, whichever is smaller. share is the "
          "fraction of the agency's 2020 residents in the districts listed, from block interior points; area_share is "
          "the fraction of its area. A district holding under 1% of the agency's residents (or none) is an edge contact.")


def write_outputs(a, g, records, aliases, roster, release, release_link, tally, report, cov_meta):
    recs = sorted(records.values(), key=lambda r: (CLASSES.index(r["class"]), r["name"].casefold(), r["name"], r["type"], r["county"]))
    pos = {r["key"]: i for i, r in enumerate(recs)}
    county_list = list(CA_COUNTIES) + sorted({r["county"] for r in recs} - set(CA_COUNTIES))
    types = sorted({r["type"] for r in recs})
    notes = sorted({r["note"] for r in recs if r["note"]})

    def flat(rows):
        out = []
        for d, s, ar in rows:
            out += [d, s, ar]
        return out

    agencies = []
    for r in recs:
        agencies.append([r["name"], types.index(r["type"]), county_list.index(r["county"]), CLASSES.index(r["class"]),
                         BASES.index(r["basis"]), notes.index(r["note"]) if r["note"] else -1,
                         flat(r["ad"]), flat(r["sd"]), sorted(r["release"]), 1 if r["roster"] else 0])
    alias_out = {}
    for n in sorted(aliases):
        ix = sorted(pos[k] for k in aliases[n])
        alias_out[n] = ix[0] if len(ix) == 1 else ix

    chambers = {}
    for ch, total in (("ad", 80), ("sd", 40)):
        rows = []
        for n in range(1, total + 1):
            m = g.equiv[ch] == n
            c = collections.Counter()
            for cn, p in zip(g.block_county[m].tolist(), g.pop[m].tolist()):
                c[cn] += p
            # every county with a block in the district, most residents first
            for cn in set(g.block_county[m].tolist()):
                c[cn] += 0
            rows.append([n, [county_list.index(cn) for cn, _ in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))]])
        chambers[ch] = rows

    by_basis = collections.Counter(r["basis"] for r in recs)
    by_class = collections.Counter(r["class"] for r in recs)
    by_class_basis = {c: dict(sorted(collections.Counter(r["basis"] for r in recs if r["class"] == c).items())) for c in CLASSES}
    edge = collections.Counter()
    for r in recs:
        for ch in ("ad", "sd"):
            for d, s, ar in r[ch]:
                edge[ch + "_pairs"] += 1
                if s is None or s < 10:
                    edge[ch + "_edge"] += 1
    rel_mapped = sum(1 for e in release if e["name"] in release_link and records[release_link[e["name"]]]["basis"] != "unmapped")
    counts = {
        "agencies": len(recs),
        "by_basis": {b: by_basis.get(b, 0) for b in BASES},
        "by_class": {c: by_class.get(c, 0) for c in CLASSES},
        "by_class_basis": by_class_basis,
        "roster": {c: dict(sorted(tally[c].items())) for c in CLASSES},
        "release_names": len(release),
        "release_names_mapped": rel_mapped,
        "release_names_unmapped": len(release) - rel_mapped,
        "names": {k[len("names_"):]: dict(sorted(v.items())) for k, v in sorted(tally.items()) if k.startswith("names_")},
        "aliases": len(alias_out),
        "pairs": dict(sorted(edge.items())),
    }
    meta = {
        "plan": PLAN, "plan_note": PLAN_NOTE, "source": SOURCE, "method": METHOD, "caveat": CAVEAT,
        "built_utc": "", "vintage": "TIGER/Line 2026 boundaries; 2020 census population",
        "coverage_written_utc": cov_meta.get("written_utc"), "release_commit": cov_meta.get("release_commit"),
        "counts": counts,
    }
    payload = {
        "meta": meta,
        "counties": county_list,
        "types": types,
        "classes": CLASSES,
        "bases": BASES,
        "notes": notes,
        "chambers": chambers,
        "columns": ["name", "type", "county", "class", "basis", "note", "ad", "sd", "release", "roster"],
        "district_columns": ["n", "share_permille", "area_share_permille"],
        "agencies": agencies,
        "aliases": alias_out,
    }
    os.makedirs(a.out, exist_ok=True)
    out = os.path.join(a.out, "districts.json")
    meta["built_utc"] = previous_built(out, payload) or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    write_atomic(out, body)

    src = os.path.join(a.out, "sources.csv")
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["name", "type", "county", "basis", "source", "source_url", "feature", "note"])
    for r in recs:
        if r["basis"] == "boundary":
            continue
        s = r["src"] or {"source": "", "url": "", "feature": ""}
        w.writerow([r["name"], r["type"], r["county"], r["basis"], s["source"], s["url"], s["feature"], r["note"]])
    write_atomic(src, buf.getvalue().encode("utf-8"))

    summary = {"bytes": len(body), "counts": counts, "report": {k: sorted(v) for k, v in sorted(report.items())}}
    if a.report:
        write_atomic(a.report, json.dumps(summary, ensure_ascii=False, indent=1).encode("utf-8"))
    print(json.dumps({"ok": True, "file": out, "bytes": len(body), "agencies": len(recs), "aliases": len(alias_out),
                      "by_basis": counts["by_basis"], "by_class": counts["by_class"],
                      "report": {k: len(v) for k, v in sorted(report.items())}}))


def previous_built(path, payload):
    """The old built_utc when nothing else changed, so a rebuild is a no-op."""
    try:
        with open(path, encoding="utf-8") as fh:
            old = json.load(fh)
    except (OSError, ValueError):
        return None
    stamp = old.get("meta", {}).get("built_utc")
    old["meta"]["built_utc"] = ""
    return stamp if old == json.loads(json.dumps(payload)) else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("fetch", "build"):
        p = sub.add_parser(name)
        p.add_argument("--geo", required=True, help="raw input folder (tiger2026/, pl2020/, swdb2021/, special/)")
        p.add_argument("--repo", default=REPO)
        p.add_argument("--data-root", default=os.environ.get("MFA_DATA_ROOT") or os.path.join(os.path.dirname(REPO), "mfa-data"))
        if name == "fetch":
            p.add_argument("--refresh", action="store_true", help="download the special district layers again")
        else:
            p.add_argument("--out", default=os.path.join(REPO, "legislative"))
            p.add_argument("--report", help="write the match report (lists of every exception) to this JSON file")
    a = ap.parse_args()
    if a.cmd == "fetch":
        cmd_fetch(a)
    else:
        cmd_build(a)


if __name__ == "__main__":
    sys.exit(main())
