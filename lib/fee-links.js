// Fee programs the release prints under different names or fund numbers in
// different years, joined into one fee for display. The release's rows are
// unchanged; each figure keeps the name its report printed.
//
// [jurisdiction, earlier name, later name, evidence, detail]. Every link was
// checked against the reports:
//   balance   the earlier name's closing balance is the later name's opening
//             balance (detail: the amount)
//   reprint   the later name's page reprints the earlier name's figures
//             (detail: the years reprinted)
//   restated  same name and fee, renumbered; the opening balance differs
//             slightly from the prior closing (detail: closing -> opening)
//   renamed   same fund number, retitled (detail: the fund number)
//   wording   the names differ only in wording ("Fee" / "Fees", "Facility")
//             and fund number, if any, is the same
// Pairs with none of these stay separate fees (Carpinteria's 2014-15 and
// 2024-25 accounts, Woodland's Fund 584).

export const FEE_LINKS = [
  // City of Adelanto
  ["City of Adelanto", "Drainage Impact fees", "Drainage Impact", "wording", ""],
  // City of Brentwood
  ["City of Brentwood", "Community Facility", "Community Facilities", "balance", "$419,942"],
  ["City of Brentwood", "Fire Facility", "Fire", "balance", "$774,300"],
  ["City of Brentwood", "Parks and Trails Facility", "Parks and Trails", "balance", "−$173,112"],
  ["City of Brentwood", "Roadway Facility", "Roadway", "balance", "$4,737,899"],
  ["City of Brentwood", "Wastewater Facility", "Wastewater", "balance", "$569,725"],
  ["City of Brentwood", "Water Facility", "Water", "balance", "−$8,007,173"],
  // City of Chino
  ["City of Chino", "Circulation (Streets, Signals, and Bridges) System (Fund 220)", "Citywide Circulation (Streets, Signals, and Bridges) System (Fund 220)", "balance", "$30,725,958"],
  ["City of Chino", "Congestion Management Program (Fund 270)", "The Preserve Congestion Management Program (Fund 270)", "balance", "$8,696,494"],
  ["City of Chino", "Sewage Collections System (Fund 254)", "Citywide Sewage Collections System (Fund 254)", "balance", "$3,392,572"],
  ["City of Chino", "Sewage Collections System (Fund 262)", "The Preserve Sewage Collections System (Fund 262)", "balance", "$556,331"],
  ["City of Chino", "Storm Drainage Collection System Facilities (Fund 255)", "Citywide Storm Drainage Collection System Facilities (Fund 255)", "balance", "$1,340,739"],
  ["City of Chino", "Storm Drainage Collection System Facilities (Fund 263)", "The Preserve Storm Drainage Collection System Facilities (Fund 263)", "balance", "$4,017,498"],
  ["City of Chino", "Water Source Storage and Distribution (Fund 253)", "Citywide Water Source Storage and Distribution (Fund 253)", "balance", "−$374,621"],
  // City of Dixon
  ["City of Dixon", "Administrative Facilities Impact Fee", "Administrative Facilities Impact Fees", "wording", ""],
  ["City of Dixon", "Drainage Improvement Impact Fee", "Drainage Improvement Impact Fees", "wording", ""],
  ["City of Dixon", "Fire Facilities Impact Fee", "Fire Facilities Impact Fees", "wording", ""],
  ["City of Dixon", "Police Facilities Impact Fee", "Police Facilities Impact Fees", "wording", ""],
  ["City of Dixon", "Sewer Connection Fee", "Sewer Connection Fees", "wording", ""],
  ["City of Dixon", "Transportation Impact Fee", "Transportation Impact Fees", "wording", ""],
  ["City of Dixon", "Water Connection Fee", "Water Connection Fees", "wording", ""],
  // City of Emeryville
  ["City of Emeryville", "Affordable Hsg Impact Fee - Non-Residential (Fund 239)", "Affordable Housing Impact Fee - Non-Residential (Fund 239)", "balance", "$479,615"],
  ["City of Emeryville", "Traffic Impact Fees - Non-Residential (effective Sep 2014) (Fund 250)", "Transportation Impact Fees - Non-Residential (effective Sep 2014) (Fund 250)", "reprint", "2014-15"],
  ["City of Emeryville", "Traffic Impact Fees - Residential (effective Sep 2014) (Fund 250)", "Transportation Impact Fees - Residential (effective Sep 2014) (Fund 250)", "renamed", "250"],
  // City of Fillmore
  ["City of Fillmore", "Fire Substation Development Impact Fees (Fund 401)", "Fire Substation (Fund 401)", "wording", ""],
  ["City of Fillmore", "Park Development Impact Fees (Fund 404)", "Parkland (Fund 404)", "renamed", "404"],
  ["City of Fillmore", "Public Facility - City - Development Impact Fee (Fund 408)", "Public Facilities - City (Fund 408)", "wording", ""],
  ["City of Fillmore", "Public Facility - Fire - Development Impact Fee (Fund 409)", "Public Facilities - Fire (Fund 409)", "wording", ""],
  ["City of Fillmore", "Public Facility - Police - Development Impact Fee (Fund 410)", "Public Facilities - Police (Fund 410)", "wording", ""],
  ["City of Fillmore", "Public Facility - Public Works - Development Impact Fee (Fund 412)", "Public Facilities - Public Works (Fund 412)", "wording", ""],
  ["City of Fillmore", "Sewer Development Impact Fees (Fund 406)", "Sewer Facilities (Fund 406)", "wording", ""],
  ["City of Fillmore", "Storm Drain Development Impact Fees (Fund 407)", "Storm Drain Facilities (Fund 407)", "wording", ""],
  ["City of Fillmore", "Transportation Development Impact Fees (Fund 403)", "Transportation (Fund 403)", "wording", ""],
  ["City of Fillmore", "Water Development Impact Fees (Fund 405)", "Water Facilities (Fund 405)", "wording", ""],
  // City of Gilroy
  ["City of Gilroy", "Public Facility Impact Fee (Fund 440)", "Public Facilities Impact Fee (Fund 440)", "wording", ""],
  ["City of Gilroy", "Sewer Development Impact Fee (Fund 435)", "Sewer Development Impact Fee (Fund 430)", "balance", "$13,182,409"],
  ["City of Gilroy", "Sewer Impact Fee (Fund 435)", "Sewer Development Impact Fee (Fund 435)", "wording", ""],
  ["City of Gilroy", "Storm Drain Development Impact Fee (Fund 420)", "Storm Drain Development Impact Fee (Fund 410)", "balance", "$2,078,854"],
  ["City of Gilroy", "Storm Drain Impact Fee (Fund 420)", "Storm Drain Development Impact Fee (Fund 420)", "balance", "$2,009,875"],
  ["City of Gilroy", "Storm Impact Fee (Fund 420)", "Storm Drain Impact Fee (Fund 420)", "balance", "$1,999,953"],
  ["City of Gilroy", "Street Tree Development Impact Fee (Fund 432)", "Street Tree Development Impact Fee (Fund 420)", "balance", "$139,092"],
  ["City of Gilroy", "Street Trees Development Fee (Fund 432)", "Street Tree Development Impact Fee (Fund 432)", "wording", ""],
  ["City of Gilroy", "Traffic Impact Fee (Fund 433)", "Traffic Impact Fee (Fund 425)", "balance", "$14,258,526"],
  ["City of Gilroy", "Water Development Impact Fee (Fund 436)", "Water Development Impact Fee (Fund 435)", "balance", "$5,102,066"],
  ["City of Gilroy", "Water Impact Fee (Fund 436)", "Water Development Impact Fee (Fund 436)", "wording", ""],
  // City of Gonzales
  ["City of Gonzales", "Sewer Impact Fund", "Sewer Impact", "wording", ""],
  // City of Guadalupe
  ["City of Guadalupe", "Water capital connection impact fees", "Water capital connection fees", "reprint", "2019-20"],
  // City of Indio
  ["City of Indio", "Supplemental Water Supply (Fund 15)", "Supplemental Water Supply (Fund 321)", "reprint", "revenue 2018 to 2020"],
  // City of La Verne
  ["City of La Verne", "Development Impact Fee - Fire Facilities Development", "Development Impact Fee - Fire Facilities", "wording", ""],
  // City of Lafayette
  ["City of Lafayette", "Drainage Impact Fee", "Drainage", "balance", "$242,890"],
  ["City of Lafayette", "Park Facilities Impact Fee", "Park Facilities", "balance", "$493,043"],
  ["City of Lafayette", "Transportation Impact Fee", "Transportation", "balance", "$967,001"],
  ["City of Lafayette", "Walkways Impact Fee", "Walkways", "balance", "$234,264"],
  // City of Merced
  ["City of Merced", "Facilities-Admin Fee (Fund 096)", "Facilities-Admin Fee (Fund 3514)", "balance", "$680"],
  ["City of Merced", "Facilities-Fire (Fund 046)", "Facilities-Fire (Fund 3502)", "balance", "$1,632,885.78"],
  ["City of Merced", "Facilities-Fire-Developer (Fund 056)", "Facilities-Fire-Developer (Fund 3507)", "balance", "$2,237,273.15"],
  ["City of Merced", "Facilities-Info Tech (Fund 094)", "Facilities-Info Tech (Fund 3512)", "balance", "$147.26"],
  ["City of Merced", "Facilities-PW Corp Yard (Fund 092)", "Facilities-PW Corp Yard (Fund 3510)", "balance", "$190.36"],
  ["City of Merced", "Facilities-Parks (Fund 048)", "Facilities-Parks (Fund 3504)", "balance", "$1,048,386.42"],
  ["City of Merced", "Facilities-Police (Fund 047)", "Facilities-Police (Fund 3503)", "balance", "$2,668,580.94"],
  ["City of Merced", "Facilities-Police-Developer (Fund 057)", "Facilities-Police-Developer (Fund 3508)", "balance", "$2,008,857.24"],
  ["City of Merced", "Facilities-Roadways (Fund 044)", "Facilities-Roadways (Fund 3500)", "balance", "$8,966,729.60"],
  ["City of Merced", "Facilities-Roadways-Developer (Fund 054)", "Facilities-Roadways-Developer (Fund 3505)", "balance", "$6,978,865.46"],
  ["City of Merced", "Facilities-Traffic Signals (Fund 045)", "Facilities-Traffic Signals (Fund 3501)", "balance", "$367,564.07"],
  ["City of Merced", "Facilities-Traffic Signals-Developer (Fund 055)", "Facilities-Traffic Signals-Developer (Fund 3506)", "balance", "$708,030.28"],
  ["City of Merced", "Park Reserve Capital Improvements (Fund 442)", "Park Reserve Capital Improvements (Fund 5001)", "balance", "$1,377,038.56"],
  // City of Newport Beach
  ["City of Newport Beach", "Fair Share Fees", "Fair Share", "wording", ""],
  // City of Ontario
  ["City of Ontario", "Aquatics Center Facilities (Fund 110)", "Aquatics Facilities (Fund 110)", "restated", "$754,867 → $754,866"],
  ["City of Ontario", "Library Expansion Facilities (Fund 108)", "Library Facilities and Collection (Fund 108)", "balance", "$8,406,089"],
  ["City of Ontario", "Public Meeting Facilities (Fund 109)", "Public Use Facilities (Fund 109)", "balance", "$8,951,931"],
  // City of Redding
  ["City of Redding", "Citywide Traffic Impact Fees (Fund 128-563)", "Citywide Traffic Impact Fees (Fund 151-1691)", "restated", "$8,622,854.93 → $8,950,223.12"],
  ["City of Redding", "Dana Drive Impact Fee (Fund 128-564)", "Dana Drive Impact Fee (Fund 151-1693)", "restated", "$524,247.03 → $524,139.77"],
  ["City of Redding", "Fire Facility Impact Fee (Fund 128-562)", "Fire Facility Impact Fee (Fund 151-1699)", "restated", "$1,335,038.72 → $1,334,766.18"],
  ["City of Redding", "North Redding Traffic Benefit District (Fund 128-565)", "North Redding Traffic Benefit District (Fund 151-1694)", "restated", "$146,085.40 → $146,055.51"],
  ["City of Redding", "Park and Recreation Facilities Impact Fee (Fund 128-619)", "Park and Recreation Facilities Impact Fee (Fund 151-1796)", "restated", "$5,113,967.03 → $4,962,862.10"],
  // City of San Luis Obispo
  ["City of San Luis Obispo", "Citywide Parkland Development Impact Fee – Fund 510", "Citywide Park Development Impact Fee – Fund 510", "balance", "$1,246,760.12"],
  // City of Santa Ana
  ["City of Santa Ana", "Transportation System Improvement Area Fee - Area C-2 (Fund 048)", "Transit Zoning Code (Fund 048)", "balance", "$216,390.17"],
  ["City of Santa Ana", "Transportation System Improvement Area Fee - Area G (Fund 049)", "Harbor Specific Plan (Fund 049)", "balance", "$99,737.80"],
  // City of Santa Clarita
  ["City of Santa Clarita", "Fire Facilities Mitigation Fee", "Fire Facilities Fee", "wording", ""],
  ["City of Santa Clarita", "Library Facilities and Technology Mitigation Fee", "Library Facilities and Technology Fee", "wording", ""],
  // City of Scotts Valley
  ["City of Scotts Valley", "Library Facilities Fee (Fund 068)", "Library Facilities Fee (Fund 086)", "restated", "$181,165 → $179,165"],
  // City of Sierra Madre
  ["City of Sierra Madre", "General Government", "General Government Facilities (Fund 34002)", "balance", "$70,429"],
  ["City of Sierra Madre", "Library", "Library Facilities (Fund 34004)", "balance", "$27,729"],
  ["City of Sierra Madre", "Public Safety", "Public Safety Facilities (Fund 34005)", "balance", "$40,124"],
  ["City of Sierra Madre", "Transportation/Traffic", "Transportation/Traffic Facilities (Fund 34007)", "balance", "$229,818"],
  ["City of Sierra Madre", "Water", "Water Facilities (Fund 34008)", "balance", "$206,999"],
  // City of South San Francisco
  ["City of South San Francisco", "Sewer Impact Fee (Fund 810)", "East of 101 Sewer Impact Fee (Fund 810)", "balance", "$4,144,279"],
  ["City of South San Francisco", "Traffic Impact Fee (Fund 820)", "East of 101 Traffic Impact Fee (Fund 820)", "balance", "$20,593,457"],
  // City of Stanton
  ["City of Stanton", "Community Center Fee", "Community Centers Fee", "wording", ""],
  ["City of Stanton", "Street Impact Fee", "Streets Impact Fee", "wording", ""],
  ["City of Stanton", "Traffic Signal Impact Fee", "Traffic Signals Impact Fee", "wording", ""],
  // City of Stockton
  ["City of Stockton", "City Office Spaces Impact Fee Fund 310-314", "City Office Spaces Impact Fee Fund 310-314 [2022-23]", "wording", ""],
  ["City of Stockton", "Delta Water Surface Connection Fee Fund 600-606", "Delta Water Surface Connection Fee Fund 600-606 [2022-23]", "balance", "$14,130,760"],
  ["City of Stockton", "Regional Transportation Impact Fee (RTIF) Fund 310-324", "Regional Transportation Impact Fee (RTIF) Fund 310-324 [2022-23]", "wording", ""],
  // City of Visalia
  ["City of Visalia", "Fire Impact Fund (1061)", "Fire Impact Fund (106)", "balance", "−$1,762,852"],
  ["City of Visalia", "Police Impact Fund (1051)", "Police Impact Fund (105)", "balance", "−$76,430"],
  ["City of Visalia", "Public Facility - Civic Center Impact Fund (1041)", "Public Facility - Civic Center Impact Fund (102)", "balance", "$3,436,848"],
  ["City of Visalia", "Sewer Connection Fund (1232)", "Sewer Connection Fund (232)", "balance", "−$4,299,881"],
  ["City of Visalia", "Storm Sewer Construction Fund (1221)", "Storm Sewer Construction Fund (221)", "restated", "−$571,259 → −$564,824"],
  // City of Wheatland
  ["City of Wheatland", "Parkland Facilities Impact Fee (Fund 135)", "Parkland Facilities Impact Fee (Fund 135000)", "reprint", "2023-24"],
  // City of Winters
  ["City of Winters", "Fire Impact Fee", "Fire", "wording", ""],
  ["City of Winters", "General Impact Fee", "General", "wording", ""],
  ["City of Winters", "Monitoring Fee", "Monitoring", "wording", ""],
  ["City of Winters", "Parks Impact Fee", "Parks", "wording", ""],
  ["City of Winters", "Public Safety Impact Fee", "Public Safety", "wording", ""],
  ["City of Winters", "Sewer Impact Fee", "Sewer", "wording", ""],
  ["City of Winters", "Water Impact Fee", "Water", "wording", ""],
  // City of Woodland
  ["City of Woodland", "Fire Development Fund (Fund 560)", "Fire Development Fund (Fund 1560)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Fire SLIF Fund (Fund 660)", "Fire SLIF Fund (Fund 1660)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "General City Development (Fund 510)", "General City Development (Fund 1510)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Library Development Fund (Fund 570)", "Library Development Fund (Fund 1570)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Park & Recreation Development (Fund 540)", "Park & Recreation Development (Fund 1540)", "reprint", "2020-21"],
  ["City of Woodland", "Park SLIF Fund (Fund 640)", "Park SLIF Fund (Fund 1640)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Police Development Fund (Fund 550)", "Police Development Fund (Fund 1550)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Road Development Fund (Fund 582)", "Road Development Fund (Fund 1582)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Roads SLIF Fund (Fund 682)", "Roads SLIF Fund (Fund 1682)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Sewer SLIF Fund (Fund 685)", "Sewer SLIF Fund (Fund 1685)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Storm Drain Development Fund (Fund 581)", "Storm Drain Development Fund (Fund 1581)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Storm Drainage SLIF Fund (Fund 681)", "Storm Drainage SLIF Fund (Fund 1681)", "reprint", "2018-19 to 2019-20"],
  ["City of Woodland", "Surface Water Development Fund (Fund 580)", "Water Development Fund (Fund 580)", "reprint", "2016-17 to 2018-19"],
  ["City of Woodland", "Wastewater Development Fund (Fund 585)", "Wastewater Development Fund (Fund 1585)", "reprint", "2018-19 to 2020-21"],
  ["City of Woodland", "Water Development Fund (Fund 580)", "Water Development Fund (Fund 1580)", "reprint", "2020-21"],
  ["City of Woodland", "Water SLIF Fund (Fund 684)", "Water SLIF Fund (Fund 1684)", "reprint", "2018-19 to 2020-21"],
  // City of Yorba Linda
  ["City of Yorba Linda", "Traffic Impact Fees", "Traffic Development Impact Fees", "balance", "$458,788.22"],
  // County of Butte
  ["County of Butte", "Public Works-Transportation Facilities Fees Unincorporated Area (Fund 5215)", "Transportation Facilities Fees Unincorporated Area (Fund 5215)", "balance", "$1,082,062.12"],
  // County of Sonoma
  ["County of Sonoma", "North County (Cloverdale & Healdsburg) Park Mitigation Trust (Park Mitigation Area 2, Fund 11113)", "North County (Cloverdale Healdsburg) Park Mitigation Trust (Park Mitigation Area 2, Fund 11113)", "wording", ""],
  // Indio Water Authority
  ["Indio Water Authority", "Supplemental Water Supply (Fund 15)", "Supplemental Water Supply (Fund 015)", "wording", ""],
];
