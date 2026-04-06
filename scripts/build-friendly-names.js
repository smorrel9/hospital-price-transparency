/**
 * build-friendly-names.js
 * Creates a friendly_names table in the database that maps CPT/HCPCS codes
 * to plain-English names consumers can understand.
 *
 * Three layers:
 *   1. Hand-curated names for common consumer-searched procedures
 *   2. Abbreviation expansion for all CPT/HCPCS descriptions
 *   3. Original description as fallback
 *
 * Also builds a search_terms column with synonyms (MRI = MR = magnetic resonance)
 * so consumer searches work regardless of terminology.
 *
 * Usage: node scripts/build-friendly-names.js
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'prices.db');

// Hand-curated friendly names for the most consumer-relevant procedures.
// Format: CPT code -> { name, searchTerms (extra keywords for search) }
const CURATED = {
  // Emergency
  '99281': { name: 'Emergency Room Visit - Minor Problem' },
  '99282': { name: 'Emergency Room Visit - Low Complexity' },
  '99283': { name: 'Emergency Room Visit - Moderate Complexity' },
  '99284': { name: 'Emergency Room Visit - High Complexity' },
  '99285': { name: 'Emergency Room Visit - Highest Complexity' },

  // Office visits
  '99213': { name: 'Office Visit - Established Patient, Low Complexity' },
  '99214': { name: 'Office Visit - Established Patient, Moderate Complexity' },
  '99215': { name: 'Office Visit - Established Patient, High Complexity' },
  '99202': { name: 'Office Visit - New Patient, Low Complexity' },
  '99203': { name: 'Office Visit - New Patient, Moderate Complexity' },
  '99204': { name: 'Office Visit - New Patient, High Complexity' },
  '99205': { name: 'Office Visit - New Patient, Highest Complexity' },

  // Imaging - MRI
  '70551': { name: 'Brain MRI without Contrast', search: 'head MRI MR magnetic resonance' },
  '70552': { name: 'Brain MRI with Contrast', search: 'head MRI MR magnetic resonance' },
  '70553': { name: 'Brain MRI with and without Contrast', search: 'head MRI MR magnetic resonance' },
  '70540': { name: 'Face/Neck MRI without Contrast', search: 'MRI MR orbit' },
  '70542': { name: 'Face/Neck MRI with Contrast', search: 'MRI MR orbit' },
  '70543': { name: 'Face/Neck MRI with and without Contrast', search: 'MRI MR orbit' },
  '71550': { name: 'Chest MRI without Contrast', search: 'MRI MR lung thorax' },
  '71551': { name: 'Chest MRI with Contrast', search: 'MRI MR lung thorax' },
  '71552': { name: 'Chest MRI with and without Contrast', search: 'MRI MR lung thorax' },
  '72141': { name: 'Spine MRI (Cervical) without Contrast', search: 'MRI MR neck spine' },
  '72142': { name: 'Spine MRI (Cervical) with Contrast', search: 'MRI MR neck spine' },
  '72146': { name: 'Spine MRI (Thoracic) without Contrast', search: 'MRI MR back spine' },
  '72147': { name: 'Spine MRI (Thoracic) with Contrast', search: 'MRI MR back spine' },
  '72148': { name: 'Spine MRI (Lumbar) without Contrast', search: 'MRI MR lower back spine' },
  '72149': { name: 'Spine MRI (Lumbar) with Contrast', search: 'MRI MR lower back spine' },
  '72158': { name: 'Spine MRI (Lumbar) with and without Contrast', search: 'MRI MR lower back spine' },
  '73221': { name: 'Upper Arm/Shoulder MRI without Contrast', search: 'MRI MR joint' },
  '73222': { name: 'Upper Arm/Shoulder MRI with Contrast', search: 'MRI MR joint' },
  '73223': { name: 'Upper Arm/Shoulder MRI with and without Contrast', search: 'MRI MR joint' },
  '73721': { name: 'Lower Leg/Knee MRI without Contrast', search: 'MRI MR joint knee' },
  '73722': { name: 'Lower Leg/Knee MRI with Contrast', search: 'MRI MR joint knee' },
  '73723': { name: 'Lower Leg/Knee MRI with and without Contrast', search: 'MRI MR joint knee' },
  '74181': { name: 'Abdomen MRI without Contrast', search: 'MRI MR belly stomach' },
  '74182': { name: 'Abdomen MRI with Contrast', search: 'MRI MR belly stomach' },
  '74183': { name: 'Abdomen MRI with and without Contrast', search: 'MRI MR belly stomach' },
  '72195': { name: 'Pelvis MRI without Contrast', search: 'MRI MR hip' },
  '72196': { name: 'Pelvis MRI with Contrast', search: 'MRI MR hip' },
  '72197': { name: 'Pelvis MRI with and without Contrast', search: 'MRI MR hip' },

  // MR Angiography
  '70544': { name: 'Head MR Angiography without Contrast', search: 'MRA MRI brain blood vessels' },
  '70545': { name: 'Head MR Angiography with Contrast', search: 'MRA MRI brain blood vessels' },
  '70546': { name: 'Head MR Angiography with and without Contrast', search: 'MRA MRI brain blood vessels' },
  '70547': { name: 'Neck MR Angiography without Contrast', search: 'MRA MRI carotid blood vessels' },
  '70548': { name: 'Neck MR Angiography with Contrast', search: 'MRA MRI carotid blood vessels' },
  '70549': { name: 'Neck MR Angiography with and without Contrast', search: 'MRA MRI carotid blood vessels' },

  // Imaging - CT
  '70450': { name: 'Head CT without Contrast', search: 'CT scan brain cat scan' },
  '70460': { name: 'Head CT with Contrast', search: 'CT scan brain cat scan' },
  '70470': { name: 'Head CT with and without Contrast', search: 'CT scan brain cat scan' },
  '71250': { name: 'Chest CT without Contrast', search: 'CT scan lung cat scan' },
  '71260': { name: 'Chest CT with Contrast', search: 'CT scan lung cat scan' },
  '71270': { name: 'Chest CT with and without Contrast', search: 'CT scan lung cat scan' },
  '74176': { name: 'Abdomen and Pelvis CT without Contrast', search: 'CT scan cat scan belly' },
  '74177': { name: 'Abdomen and Pelvis CT with Contrast', search: 'CT scan cat scan belly' },
  '74178': { name: 'Abdomen and Pelvis CT with and without Contrast', search: 'CT scan cat scan belly' },

  // Imaging - X-Ray
  '71046': { name: 'Chest X-Ray (2 views)', search: 'xray radiograph lung' },
  '71045': { name: 'Chest X-Ray (1 view)', search: 'xray radiograph lung' },
  '73030': { name: 'Shoulder X-Ray (2+ views)', search: 'xray radiograph' },
  '73060': { name: 'Humerus X-Ray (2+ views)', search: 'xray radiograph arm' },
  '73070': { name: 'Elbow X-Ray (2 views)', search: 'xray radiograph' },
  '73110': { name: 'Wrist X-Ray (3+ views)', search: 'xray radiograph' },
  '73130': { name: 'Hand X-Ray (3+ views)', search: 'xray radiograph finger' },
  '73502': { name: 'Hip X-Ray (2-3 views)', search: 'xray radiograph pelvis' },
  '73552': { name: 'Femur X-Ray (2+ views)', search: 'xray radiograph thigh' },
  '73560': { name: 'Knee X-Ray (1-2 views)', search: 'xray radiograph' },
  '73562': { name: 'Knee X-Ray (3 views)', search: 'xray radiograph' },
  '73590': { name: 'Lower Leg X-Ray (2 views)', search: 'xray radiograph tibia' },
  '73610': { name: 'Ankle X-Ray (3+ views)', search: 'xray radiograph' },
  '73630': { name: 'Foot X-Ray (3+ views)', search: 'xray radiograph toe' },

  // Imaging - Ultrasound
  '76700': { name: 'Abdominal Ultrasound - Complete', search: 'sonogram belly' },
  '76705': { name: 'Abdominal Ultrasound - Limited', search: 'sonogram belly' },
  '76770': { name: 'Retroperitoneal Ultrasound - Complete', search: 'sonogram kidney' },
  '76856': { name: 'Pelvic Ultrasound - Complete', search: 'sonogram' },
  '76830': { name: 'Transvaginal Ultrasound', search: 'sonogram' },
  '93306': { name: 'Echocardiogram - Complete', search: 'heart ultrasound echo sonogram' },
  '93307': { name: 'Echocardiogram - Limited', search: 'heart ultrasound echo sonogram' },
  '93308': { name: 'Echocardiogram - Follow-up', search: 'heart ultrasound echo sonogram' },

  // Orthopedic surgery
  '27447': { name: 'Total Knee Replacement', search: 'arthroplasty joint surgery' },
  '27130': { name: 'Total Hip Replacement', search: 'arthroplasty joint surgery' },
  '29881': { name: 'Knee Arthroscopy with Meniscectomy', search: 'scope meniscus surgery' },
  '29880': { name: 'Knee Arthroscopy with Meniscectomy (Both)', search: 'scope meniscus surgery' },
  '29827': { name: 'Shoulder Arthroscopy - Rotator Cuff Repair', search: 'scope surgery' },
  '23472': { name: 'Total Shoulder Replacement', search: 'arthroplasty joint surgery' },
  '22551': { name: 'Cervical Spine Fusion (Anterior)', search: 'neck surgery spinal' },
  '22612': { name: 'Lumbar Spine Fusion (Posterior)', search: 'back surgery spinal' },

  // Cardiac
  '93000': { name: 'Electrocardiogram (EKG/ECG)', search: 'heart test rhythm' },
  '93010': { name: 'EKG Interpretation Only', search: 'heart ECG' },
  '93005': { name: 'EKG Tracing Only', search: 'heart ECG' },
  '93452': { name: 'Left Heart Catheterization', search: 'cardiac cath angiogram' },
  '93458': { name: 'Left Heart Catheterization with Angiography', search: 'cardiac cath coronary' },
  '33533': { name: 'Coronary Artery Bypass Graft (CABG) - Single', search: 'heart surgery open' },

  // Common procedures
  '43239': { name: 'Upper GI Endoscopy with Biopsy', search: 'EGD scope stomach' },
  '43249': { name: 'Upper GI Endoscopy with Dilation', search: 'EGD scope stomach esophagus' },
  '45378': { name: 'Colonoscopy (Diagnostic)', search: 'scope colon screening' },
  '45380': { name: 'Colonoscopy with Biopsy', search: 'scope colon' },
  '45385': { name: 'Colonoscopy with Polyp Removal', search: 'scope colon polypectomy' },
  '47562': { name: 'Gallbladder Removal (Laparoscopic)', search: 'cholecystectomy surgery' },
  '49505': { name: 'Inguinal Hernia Repair', search: 'groin surgery' },
  '58661': { name: 'Laparoscopy with Ovarian/Tubal Surgery', search: 'scope surgery' },
  '59400': { name: 'Routine Vaginal Delivery (Total Care)', search: 'birth labor obstetric' },
  '59510': { name: 'Cesarean Delivery (Total Care)', search: 'c-section birth obstetric' },
  '59610': { name: 'Vaginal Birth After Cesarean (VBAC, Total Care)', search: 'birth labor obstetric' },

  // Lab
  '80053': { name: 'Comprehensive Metabolic Panel', search: 'blood test CMP lab' },
  '85025': { name: 'Complete Blood Count (CBC) with Differential', search: 'blood test lab' },
  '80061': { name: 'Lipid Panel (Cholesterol)', search: 'blood test lab triglycerides' },
  '84443': { name: 'Thyroid Test (TSH)', search: 'blood test lab thyroid' },
  '81001': { name: 'Urinalysis with Microscopy', search: 'urine test lab UA' },
  '36415': { name: 'Blood Draw (Venipuncture)', search: 'lab phlebotomy needle' },
};

/**
 * Expand common medical abbreviations in CPT descriptions.
 */
const ABBREVIATIONS = [
  [/\bW\/O\b/gi, 'without'],
  [/\bW\/(?=\w)/gi, 'with '],
  [/\bW\b(?=\s+(DYE|CONTRAST|ANES|SEDATION))/gi, 'with'],
  [/\b&\b/g, 'and'],
  [/\bDYE\b/gi, 'contrast'],
  [/\bEXAM\b/gi, 'exam'],
  [/\bBX\b/gi, 'biopsy'],
  [/\bINJ\b/gi, 'injection'],
  [/\bNJX\b/gi, 'injection'],
  [/\bSX\b/gi, 'surgery'],
  [/\bPX\b/gi, 'procedure'],
  [/\bDX\b/gi, 'diagnostic'],
  [/\bXR\b/gi, 'X-ray'],
  [/\bHX\b/gi, 'history'],
  [/\bTX\b/gi, 'treatment'],
  [/\bRPR\b/gi, 'repair'],
  [/\bABD\b/gi, 'abdominal'],
  [/\bANT\b/gi, 'anterior'],
  [/\bPOST\b/gi, 'posterior'],
  [/\bBILAT\b/gi, 'bilateral'],
  [/\bUNILAT\b/gi, 'unilateral'],
  [/\bRT\b/gi, 'right'],
  [/\bLT\b/gi, 'left'],
  [/\bEXT\b/gi, 'external'],
  [/\bINT\b/gi, 'internal'],
  [/\bIMG\b/gi, 'imaging'],
  [/\bIMAG\b/gi, 'imaging'],
  [/\bGDN\b/gi, 'guidance'],
  [/\bADDL?\b/gi, 'additional'],
  [/\bEA\b/gi, 'each'],
  [/\bHR\b/gi, 'hour'],
  [/\bMIN\b/gi, 'minute'],
  [/\bSUBSQ\b/gi, 'subsequent'],
  [/\bINIT\b/gi, 'initial'],
  [/\bPROC\b/gi, 'procedure'],
  [/\bREMOV\b/gi, 'removal'],
  [/\bREMOVE\b/gi, 'removal'],
  [/\bXAM\b/gi, 'exam'],
  [/\bEVAL\b/gi, 'evaluation'],
  [/\bDPT\b/gi, 'department'],
  [/\bVST\b/gi, 'visit'],
  [/\bMDM\b/gi, 'medical decision making'],
  [/\bHI\b(?=\s+MDM)/gi, 'high'],
  [/\bMOD\b(?=\s+MDM)/gi, 'moderate'],
  [/\bLO\b(?=\s+MDM)/gi, 'low'],
  [/\bMAYX?\b/gi, 'may'],
  [/\bREQ\b/gi, 'require'],
  [/\bPHY\b/gi, 'physician'],
  [/\bQHP\b/gi, 'qualified health professional'],
];

function expandAbbreviations(desc) {
  let result = desc;
  for (const [pattern, replacement] of ABBREVIATIONS) {
    result = result.replace(pattern, replacement);
  }
  // Title case
  return result
    .split(' ')
    .map(w => {
      if (['and', 'or', 'of', 'the', 'with', 'without', 'for', 'in', 'to', 'at'].includes(w.toLowerCase()) && w !== result.split(' ')[0]) {
        return w.toLowerCase();
      }
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create friendly_names table
  db.exec(`
    DROP TABLE IF EXISTS friendly_names;
    CREATE TABLE friendly_names (
      code TEXT PRIMARY KEY,
      code_type TEXT,
      original_description TEXT,
      friendly_name TEXT,
      search_terms TEXT
    );
  `);

  // Get all unique CPT/HCPCS codes
  const codes = db.prepare(`
    SELECT DISTINCT code, code_type, description
    FROM procedures
    WHERE code_type IN ('CPT', 'HCPCS')
    ORDER BY code
  `).all();

  console.log(`Processing ${codes.length} CPT/HCPCS codes...`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO friendly_names (code, code_type, original_description, friendly_name, search_terms)
    VALUES (@code, @code_type, @original_description, @friendly_name, @search_terms)
  `);

  const insertAll = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  const rows = [];
  let curatedCount = 0;
  let expandedCount = 0;

  for (const { code, code_type, description } of codes) {
    const curated = CURATED[code];
    let friendlyName;
    let searchTerms = '';

    if (curated) {
      friendlyName = curated.name;
      searchTerms = curated.search || '';
      curatedCount++;
    } else {
      friendlyName = expandAbbreviations(description);
      expandedCount++;
    }

    // Always include original description and common synonyms in search terms
    searchTerms = [searchTerms, description, friendlyName].filter(Boolean).join(' ');

    rows.push({
      code,
      code_type,
      original_description: description,
      friendly_name: friendlyName,
      search_terms: searchTerms,
    });
  }

  insertAll(rows);

  // Create FTS index for friendly name search
  db.exec(`
    DROP TABLE IF EXISTS friendly_names_fts;
    CREATE VIRTUAL TABLE friendly_names_fts USING fts5(
      code, friendly_name, search_terms,
      content='friendly_names'
    );
    INSERT INTO friendly_names_fts(code, friendly_name, search_terms)
      SELECT code, friendly_name, search_terms FROM friendly_names;
  `);

  console.log(`Done: ${curatedCount} curated, ${expandedCount} auto-expanded`);
  console.log(`FTS index created on friendly names`);

  // Sample output
  console.log('\nSample curated:');
  const samples = db.prepare("SELECT code, friendly_name FROM friendly_names WHERE code IN ('27447','70553','99285','45380') ORDER BY code").all();
  for (const s of samples) console.log(`  ${s.code}: ${s.friendly_name}`);

  console.log('\nSample expanded:');
  const expanded = db.prepare("SELECT code, original_description, friendly_name FROM friendly_names WHERE code NOT IN ('" + Object.keys(CURATED).join("','") + "') LIMIT 5").all();
  for (const s of expanded) console.log(`  ${s.code}: ${s.original_description} -> ${s.friendly_name}`);

  db.close();
}

main().catch(console.error);
