
import React, { useState, useMemo, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Type, Chat } from "@google/genai";
import * as XLSX from 'xlsx';

// --- TYPE DEFINITIONS ---
interface Component {
  partNumber: string;
  manufacturer: string;
  description: string;
  price: string;
  datasheetLink: string;
  specs: string[];
  partStatus: string;
  rohsStatus: string;
  reachStatus: string;
}

interface AlternativeComponent extends Component {
  justification: string;
}

interface BomPart {
    partNumber: string;
    manufacturer: string;
}

interface BomHealthResult {
    partNumber: string;
    manufacturer: string;
    lifecycleStatus: string;
    stockAvailability: string;
    leadTime: string;
}

type BulkResultStatus = 'pending' | 'loading' | 'success' | 'error';
interface BulkFindResult {
    partNumber: string; // The initial part number requested
    original?: Component;
    alternatives: AlternativeComponent[];
    status: BulkResultStatus;
    error?: string;
}

interface CircuitComponent {
    id: string;
    type: 'R' | 'C' | 'LED' | 'V+' | 'GND';
    value: string;
    label: string;
    position: { x: number; y: number };
}

interface CircuitConnection {
    from: string; // "componentId.pinName"
    to: string;   // "componentId.pinName"
}

interface CircuitData {
    components: CircuitComponent[];
    connections: CircuitConnection[];
}


interface ChatMessage {
    role: 'user' | 'model';
    text: string;
    circuit?: CircuitData;
}

type ErrorType = 'API_ERROR' | 'NOT_FOUND' | 'PARSING_ERROR' | 'FILE_ERROR' | 'UNKNOWN_ERROR';

class ComponentFinderError extends Error {
    public userMessage: string;
    public type: ErrorType;
    public originalError?: any;

    constructor(message: string, userMessage: string, type: ErrorType, originalError?: any) {
        super(message);
        this.name = 'ComponentFinderError';
        this.userMessage = userMessage;
        this.type = type;
        this.originalError = originalError;
    }
}


// --- UTILITY FUNCTIONS ---
const extractJson = (text: string): any => {
    // Find the first '{' or '[' and the last '}' or ']' to extract the JSON object from a string that might be wrapped in markdown.
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    
    let startIndex = -1;
    
    if (firstBrace === -1 && firstBracket === -1) {
        throw new SyntaxError("No JSON object or array found in the response text.");
    }
    
    if (firstBrace !== -1 && firstBracket !== -1) {
        startIndex = Math.min(firstBrace, firstBracket);
    } else {
        startIndex = firstBrace !== -1 ? firstBrace : firstBracket;
    }

    const lastBrace = text.lastIndexOf('}');
    const lastBracket = text.lastIndexOf(']');
    
    const endIndex = Math.max(lastBrace, lastBracket);

    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        throw new SyntaxError("Could not find valid JSON structure in the response text.");
    }
    
    const jsonString = text.substring(startIndex, endIndex + 1);
    
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        console.error("Failed to parse extracted JSON string:", jsonString);
        throw new SyntaxError(`Could not parse the extracted JSON content from the API response. Original error: ${e.message}`);
    }
};

const cleanString = (str: string | undefined | null): string => {
    if (!str) return str || '';
    // This regex removes:
    // - Common garbage characters (diamonds, squares)
    // - Non-printable ASCII characters (control characters)
    // - Unicode replacement character U+FFFD
    return str.replace(/[◆■\uFFFD]|[\x00-\x1F\x7F]/g, '').trim();
};

const ensureHttps = (url: string): string => {
    if (!url || typeof url !== 'string' || url.toLowerCase() === 'n/a' || url.trim() === '—') {
        return "";
    }
    const trimmedUrl = url.trim();
    if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
        return trimmedUrl;
    }
    // Check if it's a plausible domain-like string, not just random text.
    if (trimmedUrl.includes('.') && !trimmedUrl.includes(' ')) {
        return `https://${trimmedUrl}`;
    }
    // If it's something else (e.g., "Not available"), don't create a link.
    return "";
};


const cleanComponentData = <T extends Component>(component: T): T => {
    if (!component) return component;

    component.partNumber = cleanString(component.partNumber);
    component.manufacturer = cleanString(component.manufacturer);
    component.description = cleanString(component.description);
    component.price = cleanString(component.price);
    component.datasheetLink = cleanString(component.datasheetLink);
    component.partStatus = cleanString(component.partStatus);
    component.rohsStatus = cleanString(component.rohsStatus);
    component.reachStatus = cleanString(component.reachStatus);

    if (component.specs) {
        component.specs = component.specs.map(cleanString);
    }

    if ('justification' in component) {
        (component as AlternativeComponent).justification = cleanString((component as AlternativeComponent).justification);
    }

    return component;
};

// --- GEMINI API LOGIC ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Schema for just a single component
const componentSchema = {
  type: Type.OBJECT,
  properties: {
    partNumber: { type: Type.STRING },
    manufacturer: { type: Type.STRING },
    description: { type: Type.STRING },
    price: { type: Type.STRING },
    datasheetLink: { type: Type.STRING, description: "A full, valid URL (including https://) to the component's datasheet." },
    specs: { type: Type.ARRAY, items: { type: Type.STRING } },
    partStatus: { type: Type.STRING, description: "The component's lifecycle status, e.g., 'Active', 'In Production', 'NRND' (Not Recommended for New Designs), 'Obsolete'." },
    rohsStatus: { type: Type.STRING, description: "e.g., 'Compliant', 'Non-Compliant', 'Compliant by Exemption'" },
    reachStatus: { type: Type.STRING, description: "e.g., 'Compliant', 'Non-Compliant', 'Affected'" },
  },
  required: ["partNumber", "manufacturer", "description", "price", "datasheetLink", "specs", "partStatus", "rohsStatus", "reachStatus"]
};

// Schema for just the alternatives
const alternativesSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        partNumber: { type: Type.STRING },
        manufacturer: { type: Type.STRING },
        description: { type: Type.STRING },
        price: { type: Type.STRING },
        datasheetLink: { type: Type.STRING, description: "A full, valid URL (including https://) to the component's datasheet." },
        specs: { type: Type.ARRAY, items: { type: Type.STRING } },
        justification: { type: Type.STRING },
        partStatus: { type: Type.STRING, description: "The component's lifecycle status, e.g., 'Active', 'In Production', 'NRND' (Not Recommended for New Designs), 'Obsolete'." },
        rohsStatus: { type: Type.STRING, description: "e.g., 'Compliant', 'Non-Compliant', 'Compliant by Exemption'" },
        reachStatus: { type: Type.STRING, description: "e.g., 'Compliant', 'Non-Compliant', 'Affected'" },
      },
      required: ["partNumber", "manufacturer", "description", "price", "datasheetLink", "specs", "justification", "partStatus", "rohsStatus", "reachStatus"]
    },
};

const bomHealthSchema = {
    type: Type.ARRAY,
    items: {
        type: Type.OBJECT,
        properties: {
            partNumber: { type: Type.STRING },
            manufacturer: { type: Type.STRING },
            lifecycleStatus: { type: Type.STRING, description: "e.g., In Production, NRND, Obsolete" },
            stockAvailability: { type: Type.STRING, description: "e.g., Good, Low, None" },
            leadTime: { type: Type.STRING, description: "e.g., Stock, 4 Weeks" },
        },
        required: ["partNumber", "manufacturer", "lifecycleStatus", "stockAvailability", "leadTime"]
    },
};


const fetchOriginalComponent = async (partNumber: string): Promise<Component> => {
  let lastError: Error = new Error("An unknown API error occurred.");
  const MAX_RETRIES = 2; // Total 3 attempts

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const geminiResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Find a specific, common, in-production electronic component that matches the following description or part number: "${partNumber}". Provide its full details, including its lifecycle status (e.g., Active, NRND, Obsolete), RoHS and REACH status. If no specific component can be found, populate all string fields with "Not Found" and the specs array with an empty array []. Otherwise, ensure all fields are populated, using "N/A" for any unavailable information. Prioritize a real, manufacturable part.`,
        config: {
          systemInstruction: "You are an expert electrical engineer's assistant specializing in electronic component sourcing. You have deep knowledge of components from distributors like Digi-Key, Mouser, and Octopart. You provide precise, structured data.",
          responseMimeType: "application/json",
          responseSchema: componentSchema,
        },
      });

      const jsonString = geminiResponse.text.trim();
      if (!jsonString) {
          throw new Error(`The AI returned an empty response for "${partNumber}".`);
      }
      const component = extractJson(jsonString) as Component;
      if (!component.partNumber || component.partNumber === "N/A" || component.partNumber === "Not Found") {
          throw new Error(`No component matching "${partNumber}" could be found.`);
      }
      return cleanComponentData(component);

    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.error(`Attempt ${attempt + 1} failed for "${partNumber}":`, lastError);

      if (lastError.message.includes("could not be found")) {
          throw new ComponentFinderError(
              `Component ${partNumber} not found.`,
              `No component matching "${partNumber}" could be found. Please check your search term and try again.`,
              'NOT_FOUND',
              e
          );
      }
      if (e instanceof SyntaxError) {
           throw new ComponentFinderError(
              `Failed to parse JSON response for ${partNumber}.`,
              "The data from the component service was malformed. Please try your search again.",
              'PARSING_ERROR',
              e
          );
      }
      
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Wait 1s, then 2s
      }
    }
  }

  console.error("All API retries failed for original component:", lastError);
  throw new ComponentFinderError(
      `API call failed for ${partNumber} after retries.`,
      `Failed to fetch details for "${partNumber}". The component service might be temporarily unavailable. Please try again later.`,
      'API_ERROR',
      lastError
  );
};

const fetchAlternatives = async (originalComponent: Component): Promise<AlternativeComponent[]> => {
    const prompt = `Given the component "${originalComponent.partNumber}" from "${originalComponent.manufacturer}" with these key specifications: ${originalComponent.specs.join(', ')}. Find up to 3 viable, in-production alternatives. For each alternative, provide all the required details, including its lifecycle status, RoHS and REACH compliance status.`;
    
    let lastError: Error = new Error("An unknown API error occurred.");
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const geminiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                  systemInstruction: "You are an expert electrical engineer's assistant specializing in electronic component sourcing and cross-referencing. You have deep knowledge of components from distributors like Digi-Key, Mouser, and Octopart.",
                  responseMimeType: "application/json",
                  responseSchema: alternativesSchema,
                },
            });

            const jsonString = geminiResponse.text.trim();
            const alternatives = extractJson(jsonString) as AlternativeComponent[];
            return alternatives.map(cleanComponentData);

        } catch(e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            console.error(`Attempt ${attempt + 1} failed for alternatives to "${originalComponent.partNumber}":`, lastError);
            
            if (e instanceof SyntaxError) {
                console.error("Could not find or parse alternatives from the AI's response. This can happen with very niche components. Continuing without alternatives.", e);
                return []; // Non-fatal: Exit immediately, no retries for parsing errors.
            }
            if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }
    
    console.warn(`Failed to fetch alternatives for "${originalComponent.partNumber}" after multiple attempts. The main component data is still available.`, lastError);
    return []; // Non-fatal: Return empty array on final failure.
};

const fetchBomHealth = async (parts: BomPart[]): Promise<BomHealthResult[]> => {
    const partsString = parts.map(p => `(Manufacturer: "${p.manufacturer}", Part Number: "${p.partNumber}")`).join(', ');
    const prompt = `For the following list of electronic components, provide their current lifecycle status, stock availability, and estimated factory lead time. If a part is not found, return its status as "Unknown". Ensure you return the original manufacturer and part number for each item. Components: ${partsString}`;

    let lastError: Error = new Error("An unknown API error occurred.");
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const geminiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    systemInstruction: "You are a supply chain analyst AI. Provide concise, accurate data on electronic component health. Use standard industry terms like 'In Production', 'NRND' (Not Recommended for New Designs), 'Obsolete', 'Good', 'Low', 'None'.",
                    responseMimeType: "application/json",
                    responseSchema: bomHealthSchema,
                },
            });

            const jsonString = geminiResponse.text.trim();
            return extractJson(jsonString) as BomHealthResult[];
        } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            console.error(`Attempt ${attempt + 1} failed for BOM health batch:`, lastError);
            if (e instanceof SyntaxError) {
                break; 
            }
            if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    console.error("Failed to fetch BOM health after retries:", lastError);
    // Return a result indicating failure for the requested parts
    return parts.map(p => ({
        partNumber: p.partNumber,
        manufacturer: p.manufacturer,
        lifecycleStatus: "Error",
        stockAvailability: "Error",
        leadTime: "Error",
    }));
};


// --- REACT COMPONENTS ---

const Header = () => (
  <header style={styles.header}>
    <h1 style={styles.title}>Component Chameleon</h1>
    <p style={styles.subtitle}>Find alternatives and analyze BOM health, powered by Gemini.</p>
  </header>
);

const SkeletonLine = ({ width, height = '0.875rem' }: { width: string; height?: string }) => (
    <div className="skeleton" style={{ width, height, marginBottom: '0.75rem' }} />
);

const ComponentCardSkeleton = () => (
    <div style={styles.card}>
        <SkeletonLine width="60%" height="1.5rem" />
        <div style={{ marginTop: '1.5rem', opacity: 0.8 }}>
            <SkeletonLine width="80%" />
            <SkeletonLine width="70%" />
            <SkeletonLine width="50%" />
        </div>
        <div style={{ marginTop: '1.5rem', opacity: 0.7 }}>
             <SkeletonLine width="30%" height="1.125rem"/>
             <div style={{ paddingLeft: '20px', marginTop: '0.5rem' }}>
                <SkeletonLine width="90%" />
                <SkeletonLine width="95%" />
                <SkeletonLine width="85%" />
             </div>
        </div>
    </div>
);

const AlternativeCardSkeleton = () => (
    <div style={{ ...styles.card, ...styles.alternativeCard }}>
        <SkeletonLine width="70%" height="1.5rem" />
         <div style={{ marginTop: '1.5rem', opacity: 0.8 }}>
            <SkeletonLine width="80%" />
            <SkeletonLine width="70%" />
            <SkeletonLine width="50%" />
        </div>
        <div style={{...styles.justificationBox, background: 'transparent', border: '1px solid #e2e8f0', marginTop: '1.5rem'}}>
            <SkeletonLine width="40%" height="1.125rem"/>
            <div style={{marginTop: '0.75rem', opacity: 0.7}}>
                <SkeletonLine width="100%" />
                <SkeletonLine width="60%" />
            </div>
        </div>
    </div>
);

const StatusBadge = ({ label, status, type }: { label: string; status: string; type: 'compliance' | 'lifecycle' }) => {
    let specificStyle: React.CSSProperties;
    const s = status ? status.toLowerCase() : 'unknown';

    if (type === 'compliance') {
        specificStyle = s.includes('compliant') ? styles.statusBadgeSuccess : styles.statusBadgeWarning;
    } else { // lifecycle
        if (s.includes('active') || s.includes('production')) {
            specificStyle = styles.statusBadgeSuccess;
        } else if (s.includes('nrnd')) {
            specificStyle = styles.statusBadgeWarning;
        } else if (s.includes('obsolete')) {
            specificStyle = styles.statusBadgeError;
        } else {
            specificStyle = styles.statusBadgeNeutral;
        }
    }

    return (
        <p style={styles.cardText}>
            <strong style={styles.strong}>{label}:</strong>{' '}
            <span style={{ ...styles.statusBadgeBase, ...specificStyle }}>{status || 'N/A'}</span>
        </p>
    );
};


const ComponentCard = ({ component, title }: { component: Component; title: string }) => {
    const datasheetUrl = ensureHttps(component.datasheetLink);

    return (
        <div style={styles.card}>
            <h3 style={styles.cardTitle}>{title}</h3>
            <p style={styles.cardText}><strong style={styles.strong}>Part Number:</strong> {component.partNumber}</p>
            <p style={styles.cardText}><strong style={styles.strong}>Manufacturer:</strong> {component.manufacturer}</p>
            <p style={styles.cardText}><strong style={styles.strong}>Price:</strong> {component.price}</p>
            {datasheetUrl && (
                <p style={styles.cardText}>
                    <strong style={styles.strong}>Datasheet:</strong>{' '}
                    <a href={datasheetUrl} target="_blank" rel="noopener noreferrer" style={styles.link}>
                        View Datasheet
                    </a>
                </p>
            )}
            <p style={styles.cardText}><strong style={styles.strong}>Description:</strong> {component.description}</p>
            <StatusBadge label="Part Status" status={component.partStatus} type="lifecycle" />
            <StatusBadge label="RoHS Status" status={component.rohsStatus} type="compliance" />
            <StatusBadge label="REACH Status" status={component.reachStatus} type="compliance" />
            {component.specs && component.specs.length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                    <strong style={styles.strong}>Key Specs:</strong>
                    <ul style={styles.specList}>
                        {component.specs.map((spec, i) => <li key={i}>{spec}</li>)}
                    </ul>
                </div>
            )}
        </div>
    );
};

interface AlternativeCardProps {
  component: AlternativeComponent;
}

const AlternativeCard: React.FC<AlternativeCardProps> = ({ component }) => {
    const datasheetUrl = ensureHttps(component.datasheetLink);

    return (
        <div style={{ ...styles.card, ...styles.alternativeCard }}>
            <h3 style={{...styles.cardTitle, margin: '0 0 1rem 0'}}>Alternative: {component.partNumber}</h3>
            <p style={styles.cardText}><strong style={styles.strong}>Manufacturer:</strong> {component.manufacturer}</p>
            <p style={styles.cardText}><strong style={styles.strong}>Price:</strong> {component.price}</p>
            {datasheetUrl && (
                <p style={styles.cardText}>
                    <strong style={styles.strong}>Datasheet:</strong>{' '}
                    <a href={datasheetUrl} target="_blank" rel="noopener noreferrer" style={styles.link}>
                    View Datasheet
                    </a>
                </p>
            )}
            <p style={styles.cardText}><strong style={styles.strong}>Description:</strong> {component.description}</p>
            <StatusBadge label="Part Status" status={component.partStatus} type="lifecycle" />
            <StatusBadge label="RoHS Status" status={component.rohsStatus} type="compliance" />
            <StatusBadge label="REACH Status" status={component.reachStatus} type="compliance" />
            {component.specs && component.specs.length > 0 && (
            <div style={{marginTop: '1rem'}}>
                <strong style={styles.strong}>Key Specs:</strong>
                <ul style={styles.specList}>
                {component.specs.map((spec, i) => <li key={i}>{spec}</li>)}
                </ul>
            </div>
            )}
            <div style={styles.justificationBox}>
            <strong style={styles.strong}>Why it's a good alternative:</strong>
            <p style={{...styles.cardText, margin: '0.5rem 0 0 0'}}>{component.justification}</p>
            </div>
        </div>
    );
};

const ComparisonView = ({ original, alternatives }: { original: Component; alternatives: AlternativeComponent[] }) => {
    const allComponents = useMemo(() => [original, ...alternatives], [original, alternatives]);

    const { headers, rows } = useMemo(() => {
        const specMaps = allComponents.map(c => {
            const map = new Map<string, string>();
            map.set('Part Number', c.partNumber);
            map.set('Manufacturer', c.manufacturer);
            map.set('Price', c.price);
            map.set('Datasheet Link', c.datasheetLink);
            map.set('Part Status', c.partStatus);
            map.set('RoHS Status', c.rohsStatus);
            map.set('REACH Status', c.reachStatus);
            c.specs.forEach(spec => {
                const parts = spec.split(':');
                if (parts.length >= 2) {
                    map.set(parts[0].trim(), parts.slice(1).join(':').trim());
                }
            });
            return map;
        });

        const originalSpecMap = specMaps[0];
        const allKeys = new Set<string>();
        specMaps.forEach(map => {
            for (const key of map.keys()) {
                allKeys.add(key);
            }
        });

        const masterParameterOrder = [
            'Part Number',
            'Manufacturer',
            'Price',
            'Part Status',
            'RoHS Status',
            'REACH Status',
            'Series',
            'Datasheet Link',
            // --- Electrical Specs ---
            'Resistance',
            'Capacitance',
            'Inductance',
            'Tolerance',
            'Voltage Rating',
            'Power Rating',
            'Current Rating',
            // --- Component-specific Specs ---
            'Composition', // Resistor
            'Temperature Coefficient', // Resistor
            'Dielectric', // Capacitor
            'ESR (Equivalent Series Resistance)', // Capacitor
            'Type', // IC
            'Core Processor', // IC
            'Speed', // IC
            'Memory Size', // IC
            'Interface', // IC
            'Voltage - Supply', // IC
            // --- Physical/Environmental Specs ---
            'Operating Temperature',
            'Package',
            'Supplier Device Package',
            'Mounting Type'
        ];

        const sortedKeys = Array.from(allKeys).sort((a, b) => {
            const indexA = masterParameterOrder.indexOf(a);
            const indexB = masterParameterOrder.indexOf(b);
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;
            return a.localeCompare(b);
        });

        const tableRows = sortedKeys.map(key => {
            const values = specMaps.map((map, index) => {
                const value = map.get(key) || '—';
                const isDifferent = index > 0 && value !== (originalSpecMap.get(key) || '—');
                return { value, isDifferent };
            });
            return { key, values };
        });

        return {
            headers: allComponents.map(c => ({ partNumber: c.partNumber, manufacturer: c.manufacturer })),
            rows: tableRows,
        };
    }, [allComponents]);

    const handleDownload = () => {
        const sheetHeaders = ['Specification', ...headers.map(h => h.partNumber)];
        const sheetRows = rows.map(row => [row.key, ...row.values.map(cell => cell.value)]);
        const worksheetData = [sheetHeaders, ...sheetRows];
        const ws = XLSX.utils.aoa_to_sheet(worksheetData);

        const highlightStyle = {
            fill: { fgColor: { rgb: "E0E7FF" } },
            font: { bold: true, color: { rgb: "3730A3" } }
        };

        rows.forEach((row, rowIndex) => {
            row.values.forEach((cell, colIndex) => {
                if (cell.isDifferent) {
                    const cellAddress = XLSX.utils.encode_cell({ r: rowIndex + 1, c: colIndex + 1 });
                    if (ws[cellAddress]) {
                        ws[cellAddress].s = highlightStyle;
                    }
                }
            });
        });

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Comparison');
        XLSX.writeFile(wb, `component_comparison_${original.partNumber}.xlsx`);
    };

    return (
        <section style={styles.comparisonSection} aria-labelledby="comparison-title">
            <div style={styles.comparisonHeader}>
                <h2 id="comparison-title" style={styles.sectionTitle}>Side-by-Side Comparison</h2>
                <button onClick={handleDownload} style={styles.downloadButton}>
                    Download XLSX
                </button>
            </div>
            <div style={styles.tableContainer}>
                <table style={styles.comparisonTable}>
                    <thead>
                        <tr>
                            <th style={styles.tableTh}>Specification</th>
                            {headers.map((h, i) => (
                                <th key={i} style={styles.tableTh}>
                                    {h.partNumber}
                                    <span style={styles.tableSubHeader}>{h.manufacturer}</span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(row => (
                            <tr key={row.key}>
                                <td style={styles.tableTdKey}>{row.key}</td>
                                {row.values.map((cell, i) => {
                                    const datasheetUrl = row.key === 'Datasheet Link' ? ensureHttps(cell.value) : '';
                                    return (
                                        <td key={i} style={{ ...styles.tableTd, ...(cell.isDifferent ? styles.highlightedCell : {}) }}>
                                            {datasheetUrl ? (
                                                <a href={datasheetUrl} target="_blank" rel="noopener noreferrer" style={styles.tableLink}>
                                                    View
                                                </a>
                                            ) : (
                                                cell.value
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
};

const ComponentFinder = () => {
    const [mode, setMode] = useState<'single' | 'bulk'>('single');

    // Single finder state
    const [partNumber, setPartNumber] = useState('');
    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const [originalComponent, setOriginalComponent] = useState<Component | null>(null);
    const [alternatives, setAlternatives] = useState<AlternativeComponent[]>([]);
    const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
    const [isLoadingAlternatives, setIsLoadingAlternatives] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Bulk finder state
    const [bulkFile, setBulkFile] = useState<File | null>(null);
    const [bulkParts, setBulkParts] = useState<string[]>([]);
    const [bulkResults, setBulkResults] = useState<BulkFindResult[]>([]);
    const [isBulkSearching, setIsBulkSearching] = useState(false);
    const [bulkError, setBulkError] = useState<string | null>(null);
    const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
    const [activeBulkResultIndex, setActiveBulkResultIndex] = useState(0);

    // Load recent searches from local storage on component mount
    React.useEffect(() => {
        try {
            const storedSearches = localStorage.getItem('componentChameleonRecentSearches');
            if (storedSearches) {
                const parsedSearches = JSON.parse(storedSearches);
                if (Array.isArray(parsedSearches)) {
                    setRecentSearches(parsedSearches);
                }
            }
        } catch (error) {
            console.error("Failed to load or parse recent searches from local storage", error);
            localStorage.removeItem('componentChameleonRecentSearches'); // Clear corrupted data
        }
    }, []);

    const saveRecentSearch = (search: string) => {
        const trimmedSearch = search.trim();
        if (!trimmedSearch) return;

        const updatedSearches = [
            trimmedSearch,
            ...recentSearches.filter(s => s.toLowerCase() !== trimmedSearch.toLowerCase())
        ].slice(0, 5); // Limit to 5 recent searches
        
        setRecentSearches(updatedSearches);
        try {
            localStorage.setItem('componentChameleonRecentSearches', JSON.stringify(updatedSearches));
        } catch (error) {
            console.error("Failed to save recent searches to local storage", error);
        }
    };

    const clearRecentSearches = () => {
        setRecentSearches([]);
        localStorage.removeItem('componentChameleonRecentSearches');
    };

    const executeSingleSearch = async (searchTerm: string) => {
        const trimmedSearchTerm = searchTerm.trim();
        if (!trimmedSearchTerm || isLoadingOriginal || isLoadingAlternatives) return;

        // This is important so the input field reflects the current search
        setPartNumber(trimmedSearchTerm);

        setIsLoadingOriginal(true);
        setError(null);
        setOriginalComponent(null);
        setAlternatives([]);

        try {
            const original = await fetchOriginalComponent(trimmedSearchTerm);
            setOriginalComponent(original);
            saveRecentSearch(trimmedSearchTerm); // Save on success
            setIsLoadingOriginal(false);

            setIsLoadingAlternatives(true);
            // Fetching alternatives is non-blocking; if it fails, we still show the original.
            const alts = await fetchAlternatives(original);
            setAlternatives(alts);
            setIsLoadingAlternatives(false);

        } catch (err) {
            if (err instanceof ComponentFinderError) {
                setError(err.userMessage);
            } else {
                setError(err instanceof Error ? err.message : 'An unknown error occurred. Please try again.');
            }
            setIsLoadingOriginal(false);
            setIsLoadingAlternatives(false);
        }
    };
    
    const handleSingleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        executeSingleSearch(partNumber);
    };


    const parseBulkFile = (file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = e.target?.result;
                const workbook = XLSX.read(data, { type: 'binary' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

                if (!json || json.length < 2) { // Must have header + at least one data row
                    setBulkError("File is empty or contains only a header. Please add part numbers to your file.");
                    return;
                }

                const headerRow = json[0].map(h => String(h).toLowerCase().trim());
                const dataRows = json.slice(1);

                const pnIndex = headerRow.findIndex(h => h.includes('part number') || h.includes('mpn'));

                if (pnIndex === -1) {
                    setBulkError("Could not find a 'Part Number' or 'MPN' column in your file. Please check the headers.");
                    return;
                }

                const parts = dataRows
                    .map(row => String(row[pnIndex] || '').trim())
                    .filter(pn => pn); // Filter out empty strings

                if (parts.length === 0) {
                     setBulkError("No valid part numbers found in the 'Part Number' column. Please check your data.");
                     return;
                }

                setBulkParts(parts);
                setBulkResults(parts.map(pn => ({ partNumber: pn, alternatives: [], status: 'pending' })));
                setBulkError(null);
                setActiveBulkResultIndex(0);

            } catch (err) {
                console.error("Error parsing bulk file:", err);
                const error = new ComponentFinderError(
                    "Failed to parse bulk file.",
                    "Failed to parse the uploaded file. Please ensure it is a valid XLSX or CSV file and that it's not corrupted.",
                    'FILE_ERROR',
                    err
                );
                setBulkError(error.userMessage);
            }
        };
        reader.readAsBinaryString(file);
    };

    const handleBulkFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setBulkFile(e.target.files[0]);
            setBulkParts([]);
            setBulkResults([]);
            setBulkError(null);
            setIsBulkSearching(false);
            setActiveBulkResultIndex(0);
            parseBulkFile(e.target.files[0]);
        }
    };

    const handleBulkSearch = async () => {
        if (bulkParts.length === 0 || isBulkSearching) return;

        setIsBulkSearching(true);
        setActiveBulkResultIndex(0);
        setBulkProgress({ current: 0, total: bulkParts.length });
        
        for (let i = 0; i < bulkParts.length; i++) {
            const partNumber = bulkParts[i];
            
            // Set current item to loading
            setBulkResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'loading' } : r));
            
            try {
                const original = await fetchOriginalComponent(partNumber);
                const alternatives = await fetchAlternatives(original); // Non-blocking
                
                setBulkResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'success', original, alternatives } : r));

            } catch (err) {
                let errorMessage: string;
                if (err instanceof ComponentFinderError) {
                    errorMessage = err.userMessage;
                } else {
                    errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
                }
                console.error(`Failed to process bulk item ${partNumber}:`, err);
                setBulkResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'error', error: errorMessage } : r));
            }
            
            setBulkProgress(prev => ({ ...prev, current: i + 1 }));
        }

        setIsBulkSearching(false);
    };
    
    const handleBulkDownload = () => {
        const successfulResults = bulkResults.filter(r => r.status === 'success' && r.original);
        if (successfulResults.length === 0) return;

        const wb = XLSX.utils.book_new();

        successfulResults.forEach(res => {
            const original = res.original!;
            const alternatives = res.alternatives;
            const allComponents = [original, ...alternatives];

            const specMaps = allComponents.map(c => {
                const map = new Map<string, string>();
                map.set('Part Number', c.partNumber);
                map.set('Manufacturer', c.manufacturer);
                map.set('Price', c.price);
                map.set('Description', c.description);
                map.set('Datasheet Link', c.datasheetLink);
                map.set('Part Status', c.partStatus);
                map.set('RoHS Status', c.rohsStatus);
                map.set('REACH Status', c.reachStatus);

                if ('justification' in c) {
                    map.set('Justification', (c as AlternativeComponent).justification);
                }
                c.specs.forEach(spec => {
                    const parts = spec.split(':');
                    if (parts.length >= 2) {
                        map.set(parts[0].trim(), parts.slice(1).join(':').trim());
                    }
                });
                return map;
            });
            
            const allKeys = new Set<string>();
            specMaps.forEach(map => {
                for (const key of map.keys()) {
                    allKeys.add(key);
                }
            });

            const masterParameterOrder = [
                'Part Number', 'Manufacturer', 'Price', 'Description', 'Datasheet Link', 'Justification',
                'Part Status', 'RoHS Status', 'REACH Status',
                'Resistance', 'Capacitance', 'Inductance', 'Tolerance', 'Voltage Rating', 'Power Rating', 'Current Rating',
                'Composition', 'Temperature Coefficient', 'Dielectric', 'ESR (Equivalent Series Resistance)', 'Type',
                'Core Processor', 'Speed', 'Memory Size', 'Interface', 'Voltage - Supply', 'Operating Temperature',
                'Package', 'Supplier Device Package', 'Mounting Type'
            ];

            const sortedKeys = Array.from(allKeys).sort((a, b) => {
                const indexA = masterParameterOrder.indexOf(a);
                const indexB = masterParameterOrder.indexOf(b);
                if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                if (indexA !== -1) return -1;
                if (indexB !== -1) return 1;
                return a.localeCompare(b);
            });

            const sheetHeaders = ['Specification', original.partNumber, ...alternatives.map(a => a.partNumber)];
            const sheetRows = sortedKeys.map(key => {
                const values = specMaps.map(map => map.get(key) || '—');
                return [key, ...values];
            });

            const worksheetData = [sheetHeaders, ...sheetRows];
            const ws = XLSX.utils.aoa_to_sheet(worksheetData);
            
            const sanitizedSheetName = original.partNumber.replace(/[\\/*?:"<>|]/g, "_").substring(0, 31);
            
            XLSX.utils.book_append_sheet(wb, ws, sanitizedSheetName);
        });

        XLSX.writeFile(wb, `bulk_alternatives_report.xlsx`);
    };

    const isSingleSearching = isLoadingOriginal || isLoadingAlternatives;
    const activeBulkResult = bulkResults[activeBulkResultIndex];

    return (
        <>
            <div style={styles.modeSwitcher}>
                 <button 
                    onClick={() => setMode('single')}
                    style={mode === 'single' ? styles.modeButtonActive : styles.modeButton}
                    aria-current={mode === 'single'}
                >
                    Single Part Finder
                </button>
                <button 
                    onClick={() => setMode('bulk')}
                    style={mode === 'bulk' ? styles.modeButtonActive : styles.modeButton}
                    aria-current={mode === 'bulk'}
                >
                    Bulk Alternate Finder
                </button>
            </div>
            
            {mode === 'single' && (
                <>
                    <form onSubmit={handleSingleSearch} style={styles.form}>
                        <input
                            type="text"
                            value={partNumber}
                            onChange={(e) => setPartNumber(e.target.value)}
                            placeholder="e.g., ATmega328P-PU or 10k resistor 0402"
                            style={styles.input}
                            aria-label="Component Part Number or Description"
                            disabled={isSingleSearching}
                        />
                        <button type="submit" style={styles.button} disabled={isSingleSearching}>
                        {isLoadingOriginal ? <><div className="spinner" /> Validating...</>
                        : isLoadingAlternatives ? <><div className="spinner" /> Finding Alts...</>
                        : 'Find Alternatives'}
                        </button>
                    </form>

                    {recentSearches.length > 0 && !isSingleSearching && (
                        <div style={styles.recentSearchesContainer}>
                            <div style={styles.recentSearchesHeader}>
                                <h4 style={styles.recentSearchesTitle}>Recent Searches</h4>
                                <button onClick={clearRecentSearches} style={styles.clearButton}>Clear</button>
                            </div>
                            <div style={styles.recentSearchesList}>
                                {recentSearches.map(search => (
                                    <button
                                        key={search}
                                        onClick={() => executeSingleSearch(search)}
                                        style={styles.recentSearchButton}
                                        title={`Search for ${search}`}
                                    >
                                        {search}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {originalComponent && alternatives.length > 0 && !isLoadingOriginal && !isLoadingAlternatives && (
                        <ComparisonView original={originalComponent} alternatives={alternatives} />
                    )}

                    <section style={styles.resultsSection} aria-live="polite">
                        {error && <p style={styles.errorText}>{error}</p>}
                        {isLoadingOriginal && <ComponentCardSkeleton />}
                        {originalComponent && !isLoadingOriginal && (
                            <>
                                <ComponentCard component={originalComponent} title="Original Component" />
                                {isLoadingAlternatives ? (
                                    <><AlternativeCardSkeleton /><AlternativeCardSkeleton /></>
                                ) : (
                                    <>
                                        {alternatives.length > 0 ? (
                                            alternatives.map((alt) => (
                                                <AlternativeCard key={alt.partNumber} component={alt} />
                                            ))
                                        ) : (
                                            <p style={styles.noResultsText}>No suitable alternatives were found.</p>
                                        )}
                                    </>
                                )}
                            </>
                        )}
                    </section>
                </>
            )}
            
            {mode === 'bulk' && (
                <div>
                     <div style={styles.fileDropzone}>
                        <input type="file" id="bulk-upload" accept=".xlsx, .csv" onChange={handleBulkFileChange} style={{ display: 'none' }} />
                        <label htmlFor="bulk-upload" style={styles.fileDropzoneLabel}>
                            {bulkFile ? `Selected: ${bulkFile.name}` : 'Click or drag to upload your list (.xlsx, .csv)'}
                            <span style={styles.fileDropzoneSubtext}>Ensure your file has a column for 'Part Number'.</span>
                        </label>
                    </div>

                    <div style={{ textAlign: 'center', margin: '1rem 0' }}>
                        <button onClick={handleBulkSearch} style={styles.button} disabled={isBulkSearching || bulkParts.length === 0}>
                            {isBulkSearching ? <><div className="spinner" /> Finding...</> : `Find Alternatives for ${bulkParts.length} Parts`}
                        </button>
                    </div>

                    {bulkError && <p style={styles.errorText}>{bulkError}</p>}
                    
                    {isBulkSearching && (
                        <p style={styles.loadingText}>
                            Processing... {bulkProgress.current} of {bulkProgress.total} parts checked.
                        </p>
                    )}

                    {bulkResults.length > 0 && (
                        <section>
                            <div style={styles.comparisonHeader}>
                                <h2 style={{ ...styles.sectionTitle, marginBottom: 0 }}>Bulk Results</h2>
                                {!isBulkSearching && bulkResults.some(r=>r.status === 'success') && (
                                    <button onClick={handleBulkDownload} style={styles.downloadButton}>
                                        Download All as XLSX
                                    </button>
                                )}
                            </div>
                            <div style={styles.bulkTabsContainer}>
                                <nav style={styles.bulkTabsNav}>
                                    {bulkResults.map((result, i) => (
                                        <button
                                            key={`${result.partNumber}-${i}`}
                                            onClick={() => setActiveBulkResultIndex(i)}
                                            style={i === activeBulkResultIndex ? styles.bulkTabButtonActive : styles.bulkTabButton}
                                            aria-current={i === activeBulkResultIndex}
                                        >
                                            {result.status === 'loading' && <div className="spinner-small" />}
                                            {result.status === 'error' && <span style={styles.statusIconError}>✖</span>}
                                            {result.status === 'success' && <span style={styles.statusIconSuccess}>✔</span>}
                                            <span style={styles.bulkTabButtonText}>{result.partNumber}</span>
                                        </button>
                                    ))}
                                </nav>
                                {activeBulkResult && (
                                    <div style={styles.bulkTabContent}>
                                        {['pending', 'loading'].includes(activeBulkResult.status) && (
                                            <>
                                                <ComponentCardSkeleton />
                                                <AlternativeCardSkeleton />
                                            </>
                                        )}
                                        {activeBulkResult.status === 'error' && <p style={styles.errorText}>{activeBulkResult.error}</p>}
                                        {activeBulkResult.status === 'success' && activeBulkResult.original && (
                                             <>
                                                <ComponentCard component={activeBulkResult.original} title="Original Component" />
                                                {activeBulkResult.alternatives.length > 0 ? (
                                                    activeBulkResult.alternatives.map((alt) => (
                                                        <AlternativeCard key={alt.partNumber} component={alt} />
                                                    ))
                                                ) : (
                                                    <p style={styles.noResultsText}>No suitable alternatives were found for this part.</p>
                                                )}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        </section>
                    )}
                </div>
            )}
        </>
    );
};

const BomHealthFinder = () => {
    const [bomFile, setBomFile] = useState<File | null>(null);
    const [bomParts, setBomParts] = useState<BomPart[]>([]);
    const [bomResults, setBomResults] = useState<BomHealthResult[]>([]);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState({ current: 0, total: 0 });

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setBomFile(e.target.files[0]);
            parseFile(e.target.files[0]);
        }
    };

    const parseFile = (file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = e.target?.result;
                const workbook = XLSX.read(data, { type: 'binary' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(worksheet) as any[];

                if (!json || json.length === 0) {
                    setError("The uploaded file is empty or contains only a header row. Please add component data to the file.");
                    setBomParts([]);
                    setBomResults([]);
                    return;
                }

                const header = Object.keys(json[0] || {});
                const normalizedHeaderMap = new Map(header.map(h => [h.toLowerCase().trim().replace(/ /g, ''), h]));

                const findKey = (aliases: string[], exclude: string[] = []): string | undefined => {
                    for (const alias of aliases) {
                        if (normalizedHeaderMap.has(alias)) {
                            const originalHeader = normalizedHeaderMap.get(alias)!;
                            if (!exclude.includes(originalHeader)) {
                                return originalHeader;
                            }
                        }
                    }
                    return undefined;
                };

                const mpnAliases = ['manufacturerpartnumber', 'mpn', 'partnumber'];
                const mpnKey = findKey(mpnAliases);

                const mfgAliases = ['manufacturername', 'manufacturer', 'mfg', 'mpn'];
                const mfgKey = findKey(mfgAliases, mpnKey ? [mpnKey] : []);

                if (!mfgKey || !mpnKey) {
                    setError("Could not find required columns. Please ensure your file has columns for both manufacturer and part number. Supported headers include 'Manufacturer', 'MFG', 'Part Number', and 'MPN'.");
                    setBomParts([]);
                    setBomResults([]);
                    return;
                }

                const parts = json.map(row => ({
                    manufacturer: String(row[mfgKey] || '').trim(),
                    partNumber: String(row[mpnKey] || '').trim()
                })).filter(p => p.manufacturer && p.partNumber);

                if (parts.length === 0) {
                    setError("The file was processed, but no valid parts were found. Please ensure the manufacturer and part number columns contain the correct text data.");
                    setBomParts([]);
                    setBomResults([]);
                    return;
                }

                setBomParts(parts);
                setError(null);
                setBomResults([]);
            } catch (err) {
                console.error("Error parsing file:", err);
                const error = new ComponentFinderError(
                    "Failed to parse BOM file.",
                    "Failed to parse the uploaded file. Please ensure it is a valid XLSX or CSV file and that it's not corrupted.",
                    'FILE_ERROR',
                    err
                );
                setError(error.userMessage);
            }
        };
        reader.readAsBinaryString(file);
    };

    const handleAnalyze = async () => {
        if (bomParts.length === 0 || isAnalyzing) return;

        setIsAnalyzing(true);
        setBomResults([]);
        setError(null);
        setProgress({ current: 0, total: bomParts.length });

        const BATCH_SIZE = 5;
        const allResults: BomHealthResult[] = [];

        for (let i = 0; i < bomParts.length; i += BATCH_SIZE) {
            const batch = bomParts.slice(i, i + BATCH_SIZE);

            try {
                const results = await fetchBomHealth(batch);
                allResults.push(...results);
                setBomResults([...allResults]); // Update UI progressively
            } catch (err) {
                console.error(`Error in batch ${i / BATCH_SIZE}:`, err);
                const errorResults = batch.map(p => ({
                    partNumber: p.partNumber,
                    manufacturer: p.manufacturer,
                    lifecycleStatus: 'API Error',
                    stockAvailability: 'API Error',
                    leadTime: 'API Error'
                }));
                allResults.push(...errorResults);
                setBomResults([...allResults]);
            }

            setProgress({ current: Math.min(i + BATCH_SIZE, bomParts.length), total: bomParts.length });
        }

        setIsAnalyzing(false);
    };

    const getStatusStyle = (status: string): React.CSSProperties => {
        const s = status.toLowerCase();
        if (s.includes('obsolete') || s.includes('none') || s.includes('error')) {
            return styles.statusCellError;
        }
        if (s.includes('nrnd') || s.includes('low')) {
            return styles.statusCellWarning;
        }
        if (s.includes('production') || s.includes('good') || s.includes('stock')) {
            return styles.statusCellSuccess;
        }
        return {};
    };

    return (
        <div>
            <div style={styles.fileDropzone}>
                <input type="file" id="bom-upload" accept=".xlsx, .csv" onChange={handleFileChange} style={{ display: 'none' }} />
                <label htmlFor="bom-upload" style={styles.fileDropzoneLabel}>
                    {bomFile ? `Selected: ${bomFile.name}` : 'Click or drag to upload your BOM (.xlsx, .csv)'}
                    <span style={styles.fileDropzoneSubtext}>Ensure your file has columns for manufacturer and part number.</span>
                </label>
            </div>

            <div style={{ textAlign: 'center', margin: '1rem 0' }}>
                <button onClick={handleAnalyze} style={styles.button} disabled={isAnalyzing || bomParts.length === 0}>
                    {isAnalyzing ? <><div className="spinner" /> Analyzing...</> : 'Analyze BOM'}
                </button>
            </div>

            {error && <p style={styles.errorText}>{error}</p>}

            {isAnalyzing && (
                 <p style={styles.loadingText}>
                    Analyzing... {progress.current} of {progress.total} parts checked.
                </p>
            )}

            {bomResults.length > 0 && (
                <section style={styles.comparisonSection}>
                    <div style={styles.sectionHeader}>
                        <h2 style={{ ...styles.sectionTitle, marginBottom: 0 }}>BOM Health Analysis</h2>
                        {isAnalyzing && <div className="spinner-small" />}
                    </div>
                    <div style={styles.tableContainer}>
                        <table style={styles.comparisonTable}>
                            <thead>
                                <tr>
                                    <th style={styles.tableTh}>Manufacturer</th>
                                    <th style={styles.tableTh}>Part Number</th>
                                    <th style={styles.tableTh}>Lifecycle Status</th>
                                    <th style={styles.tableTh}>Stock Availability</th>
                                    <th style={styles.tableTh}>Lead Time</th>
                                </tr>
                            </thead>
                            <tbody>
                                {bomResults.map((result, i) => (
                                    <tr key={`${result.manufacturer}-${result.partNumber}-${i}`}>
                                        <td style={styles.tableTd}>{result.manufacturer}</td>
                                        <td style={styles.tableTdKey}>{result.partNumber}</td>
                                        <td style={{ ...styles.tableTd, ...getStatusStyle(result.lifecycleStatus) }}>{result.lifecycleStatus}</td>
                                        <td style={{ ...styles.tableTd, ...getStatusStyle(result.stockAvailability) }}>{result.stockAvailability}</td>
                                        <td style={styles.tableTd}>{result.leadTime}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </div>
    );
};

const extractCircuitJson = (text: string): { circuit: CircuitData | null, remainingText: string } => {
    const circuitRegex = /```circuit-json\s*([\s\S]*?)\s*```/;
    const match = text.match(circuitRegex);

    if (match && match[1]) {
        try {
            const circuitJson = JSON.parse(match[1]);
            // Basic validation
            if (circuitJson.components && circuitJson.connections) {
                const remainingText = text.replace(circuitRegex, '').trim();
                return { circuit: circuitJson, remainingText };
            }
        } catch (e) {
            console.error("Failed to parse circuit JSON:", e);
        }
    }

    return { circuit: null, remainingText: text };
};

const SchematicRenderer = ({ circuitData }: { circuitData: CircuitData }) => {
    // Component dimensions and pin definitions
    const componentMetrics: {[key: string]: any} = {
        'R': { width: 60, height: 20, pins: { p1: { x: 0, y: 10 }, p2: { x: 60, y: 10 } } },
        'C': { width: 30, height: 40, pins: { p1: { x: 15, y: 0 }, p2: { x: 15, y: 40 } } },
        'LED': { width: 40, height: 40, pins: { anode: { x: 20, y: 0 }, cathode: { x: 20, y: 40 } } },
        'V+': { width: 30, height: 30, pins: { p: { x: 15, y: 15 } } },
        'GND': { width: 40, height: 20, pins: { p: { x: 20, y: 0 } } },
    };

    const getComponentSvg = (component: CircuitComponent) => {
        switch (component.type) {
            case 'R':
                return <rect x="0" y="0" width="60" height="20" stroke="black" fill="white" strokeWidth="2" />;
            case 'C':
                return <>
                    <line x1="15" y1="18" x2="15" y2="0" stroke="black" strokeWidth="2" />
                    <line x1="15" y1="22" x2="15" y2="40" stroke="black" strokeWidth="2" />
                    <line x1="5" y1="18" x2="25" y2="18" stroke="black" strokeWidth="2" />
                    <line x1="5" y1="22" x2="25" y2="22" stroke="black" strokeWidth="2" />
                </>;
            case 'LED':
                return <>
                    <line x1="20" y1="0" x2="20" y2="15" stroke="black" strokeWidth="2" />
                    <polygon points="5,15 35,15 20,30" stroke="black" fill="white" strokeWidth="2" />
                    <line x1="5" y1="15" x2="35" y2="15" stroke="black" strokeWidth="2" />
                    <line x1="20" y1="30" x2="20" y2="40" stroke="black" strokeWidth="2" />
                    {/* Arrows indicating light */}
                    <line x1="30" y1="5" x2="35" y2="0" stroke="black" strokeWidth="1.5" />
                    <line x1="35" y1="10" x2="40" y2="5" stroke="black" strokeWidth="1.5" />
                </>;
            case 'V+':
                return <>
                    <circle cx="15" cy="15" r="14" stroke="black" fill="white" strokeWidth="2" />
                    <line x1="15" y1="5" x2="15" y2="25" stroke="black" strokeWidth="2" />
                    <line x1="5" y1="15" x2="25" y2="15" stroke="black" strokeWidth="2" />
                </>;
            case 'GND':
                return <>
                    <line x1="20" y1="0" x2="20" y2="5" stroke="black" strokeWidth="2" />
                    <line x1="5" y1="5" x2="35" y2="5" stroke="black" strokeWidth="2" />
                    <line x1="10" y1="10" x2="30" y2="10" stroke="black" strokeWidth="2" />
                    <line x1="15" y1="15" x2="25" y2="15" stroke="black" strokeWidth="2" />
                </>;
            default:
                return null;
        }
    };
    
    // Calculate SVG viewbox to fit all components
    const PADDING = 40;
    if (!circuitData || !circuitData.components || circuitData.components.length === 0) {
        return null;
    }

    const allX = circuitData.components.map(c => c.position.x);
    const allY = circuitData.components.map(c => c.position.y);
    const minX = Math.min(...allX) - PADDING;
    const minY = Math.min(...allY) - PADDING;
    const maxX = Math.max(...allX.map((x, i) => x + (componentMetrics[circuitData.components[i].type]?.width || 0))) + PADDING;
    const maxY = Math.max(...allY.map((y, i) => y + (componentMetrics[circuitData.components[i].type]?.height || 0))) + PADDING;
    const width = maxX - minX;
    const height = maxY - minY;

    const getPinAbsPos = (componentId: string, pinName: string) => {
        const component = circuitData.components.find(c => c.id === componentId);
        if (!component) return null;
        const metrics = componentMetrics[component.type];
        if (!metrics || !metrics.pins[pinName]) return null;
        return {
            x: component.position.x + metrics.pins[pinName].x,
            y: component.position.y + metrics.pins[pinName].y,
        };
    };

    return (
        <div style={styles.schematicContainer}>
            <svg viewBox={`${minX} ${minY} ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
                {/* Wires */}
                {circuitData.connections.map((conn, i) => {
                    const [fromId, fromPin] = conn.from.split('.');
                    const [toId, toPin] = conn.to.split('.');
                    const fromPos = getPinAbsPos(fromId, fromPin);
                    const toPos = getPinAbsPos(toId, toPin);
                    if (!fromPos || !toPos) return null;
                    return <line key={i} x1={fromPos.x} y1={fromPos.y} x2={toPos.x} y2={toPos.y} stroke="#334155" strokeWidth="2" />;
                })}
                {/* Components */}
                {circuitData.components.map(comp => (
                    <g key={comp.id} transform={`translate(${comp.position.x}, ${comp.position.y})`}>
                        {getComponentSvg(comp)}
                        <text x={componentMetrics[comp.type].width / 2} y="-8" textAnchor="middle" fontSize="12" fill="#64748b">{comp.label}</text>
                        <text x={componentMetrics[comp.type].width / 2} y={ (componentMetrics[comp.type]?.height || 0) + 15} textAnchor="middle" fontSize="12" fill="#1e293b" fontWeight="500">{comp.value}</text>
                    </g>
                ))}
            </svg>
        </div>
    );
};

const DesignAssistant = () => {
    const chat = useRef<Chat | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [userInput, setUserInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messageListRef = useRef<HTMLDivElement>(null);

    const suggestionPrompts = [
        "Design a simple LED driver circuit",
        "Suggest a 5V regulator for a USB-powered device",
        "Help me choose a microcontroller for a simple IoT project",
        "What kind of capacitor should I use for power supply decoupling?"
    ];

    useEffect(() => {
        const initChat = () => {
            chat.current = ai.chats.create({
                model: 'gemini-2.5-flash',
                config: {
                    systemInstruction: "You are an expert electronics design assistant named Component Chameleon. You help engineers and hobbyists choose components, understand circuits, and solve design problems. When suggesting components, provide specific part numbers where possible. Use markdown for formatting lists and bold text. When asked to design a circuit, you MUST provide the schematic in a specific JSON format inside a markdown code block labeled 'circuit-json'. The JSON must have 'components' and 'connections' keys. Components must have id, type (R, C, LED, V+, GND), value, label, and position. Connections must specify 'from' and 'to' points as 'componentId.pinName'. Arrange components logically for a clean layout (e.g., power top, ground bottom, signal left-to-right).",
                },
            });
            setMessages([{
                role: 'model',
                text: "Hello! I'm your Design Assistant. How can I help you with your electronics project today? You can ask me to suggest components, explain concepts, or help you with a design idea."
            }]);
        };
        initChat();
    }, []);

    useEffect(() => {
        if (messageListRef.current) {
            messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
        }
    }, [messages, isLoading]);

    const handleSendMessage = async (messageText: string) => {
        const text = messageText.trim();
        if (!text || isLoading || !chat.current) return;

        setUserInput('');
        setIsLoading(true);
        setMessages(prev => [...prev, { role: 'user', text }]);
        
        try {
            const responseStream = await chat.current.sendMessageStream({ message: text });
            
            let modelResponse = '';
            setMessages(prev => [...prev, { role: 'model', text: '' }]);

            for await (const chunk of responseStream) {
                modelResponse += chunk.text;
                setMessages(prev => {
                    const newMessages = [...prev];
                    const lastMessage = newMessages[newMessages.length - 1];
                    if(lastMessage.role === 'model') {
                        lastMessage.text = modelResponse;
                    }
                    return newMessages;
                });
            }

            // After stream is complete, process for circuit JSON
            const { circuit, remainingText } = extractCircuitJson(modelResponse);
            setMessages(prev => {
                const newMessages = [...prev];
                const lastMessage = newMessages[newMessages.length - 1];
                if(lastMessage.role === 'model') {
                    lastMessage.text = remainingText;
                    lastMessage.circuit = circuit || undefined;
                }
                return newMessages;
            });

        } catch (error) {
            console.error("Error sending message:", error);
            const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
            setMessages(prev => {
                const newMessages = [...prev];
                const lastMessage = newMessages[newMessages.length - 1];
                if (lastMessage && lastMessage.role === 'model') {
                    lastMessage.text = `Sorry, I encountered an error: ${errorMessage}`;
                } else {
                    newMessages.push({ role: 'model', text: `Sorry, I encountered an error: ${errorMessage}` });
                }
                return newMessages;
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleFormSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        handleSendMessage(userInput);
    };

    const MarkdownRenderer = ({ text }: { text: string }) => {
        const parts = text.split(/(\*\*.*?\*\*)/g).map((part, index) => {
            if (part.startsWith('**') && part.endsWith('**')) {
                return <strong key={index}>{part.slice(2, -2)}</strong>;
            }
            return part;
        });

        // FIX: Add explicit generic type to flatMap to fix type inference issue.
        const lines = parts.flatMap<React.ReactNode>(p => typeof p === 'string' ? p.split('\n') : [p]);
        
        return <div>{lines.map((line, index) => {
             if (typeof line === 'string' && line.trim().startsWith('* ')) {
                return <li key={index}>{line.trim().substring(2)}</li>;
            }
            // FIX: The type of `line` is now correctly inferred as ReactNode, resolving the error.
            return <React.Fragment key={index}>{line}{index < lines.length -1 && <br />}</React.Fragment>
        })}</div>;
    };


    return (
        <div style={styles.chatContainer}>
            <div style={styles.messageList} ref={messageListRef}>
                {messages.map((msg, index) => (
                    <div key={index} style={msg.role === 'user' ? styles.userBubble : styles.modelBubble}>
                       <MarkdownRenderer text={msg.text} />
                       {msg.circuit && <SchematicRenderer circuitData={msg.circuit} />}
                    </div>
                ))}
                {isLoading && messages[messages.length-1]?.role === 'user' && (
                    <div style={styles.modelBubble}>
                        <div style={styles.typingIndicator}>
                            <span></span><span></span><span></span>
                        </div>
                    </div>
                )}
            </div>
            {messages.length <= 1 && !isLoading && (
                <div style={styles.promptSuggestionsContainer}>
                    {suggestionPrompts.map(prompt => (
                         <button
                            key={prompt}
                            onClick={() => handleSendMessage(prompt)}
                            style={styles.recentSearchButton}
                         >
                             {prompt}
                         </button>
                    ))}
                </div>
            )}
            <form onSubmit={handleFormSubmit} style={styles.chatInputForm}>
                <input
                    type="text"
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    placeholder="Ask a design question..."
                    style={styles.chatInput}
                    aria-label="Your message"
                    disabled={isLoading}
                />
                <button type="submit" style={styles.chatSendButton} disabled={isLoading}>
                    {isLoading ? <div className="spinner" /> : 'Send'}
                </button>
            </form>
        </div>
    );
};


const App = () => {
    const [activeTab, setActiveTab] = useState('finder');

    return (
        <main>
            <Header />
            <nav style={styles.tabsContainer}>
                <button
                    onClick={() => setActiveTab('finder')}
                    style={activeTab === 'finder' ? styles.tabButtonActive : styles.tabButton}
                    aria-current={activeTab === 'finder'}
                >
                    Component Finder
                </button>
                <button
                    onClick={() => setActiveTab('bom')}
                    style={activeTab === 'bom' ? styles.tabButtonActive : styles.tabButton}
                    aria-current={activeTab === 'bom'}
                >
                    BOM Health Finder
                </button>
                <button
                    onClick={() => setActiveTab('assistant')}
                    style={activeTab === 'assistant' ? styles.tabButtonActive : styles.tabButton}
                    aria-current={activeTab === 'assistant'}
                >
                    Design Assistant
                </button>
            </nav>
            <div style={styles.tabContent}>
                {activeTab === 'finder' && <ComponentFinder />}
                {activeTab === 'bom' && <BomHealthFinder />}
                {activeTab === 'assistant' && <DesignAssistant />}
            </div>
        </main>
    );
};

// --- STYLES ---
const styles: { [key: string]: React.CSSProperties } = {
  header: { textAlign: 'center', marginBottom: '1.5rem' },
  title: { fontSize: '2.5rem', margin: '0 0 0.5rem 0', color: 'var(--text-color)' },
  subtitle: { fontSize: '1.125rem', margin: 0, color: 'var(--subtle-text)' },
  form: { display: 'flex', gap: '0.5rem', marginBottom: '2.5rem' },
  input: {
    flexGrow: 1,
    padding: '0.75rem 1rem',
    fontSize: '1rem',
    borderRadius: '8px',
    border: '1px solid var(--border-color)',
    backgroundColor: 'var(--card-background)',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  button: {
    padding: '0.75rem 1.5rem',
    fontSize: '1rem',
    fontWeight: 500,
    color: '#fff',
    backgroundColor: 'var(--primary-color)',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '160px',
    gap: '0.5rem',
  },
  sectionTitle: { fontSize: '1.5rem', color: 'var(--text-color)', marginBottom: '1rem' },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  resultsSection: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  loadingText: { textAlign: 'center', color: 'var(--subtle-text)', fontSize: '1rem', padding: '1rem' },
  errorText: { textAlign: 'center', color: 'var(--error-color)', backgroundColor: '#fee2e2', padding: '1rem', borderRadius: '8px' },
  noResultsText: { textAlign: 'center', color: 'var(--subtle-text)', padding: '1rem', border: '1px dashed var(--border-color)', borderRadius: '8px' },
  card: {
    backgroundColor: 'var(--card-background)',
    padding: '1.5rem',
    borderRadius: '12px',
    border: '1px solid var(--border-color)',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  },
  alternativeCard: {
    borderLeft: '4px solid var(--primary-color)'
  },
  cardTitle: { marginTop: 0, marginBottom: '1rem', color: 'var(--primary-color)' },
  cardText: { margin: '0.25rem 0', lineHeight: 1.6 },
  strong: { color: '#334155', fontWeight: 600 },
  specList: { paddingLeft: '20px', margin: '0.5rem 0 0 0', color: 'var(--subtle-text)' },
  justificationBox: {
    marginTop: '1rem',
    padding: '1rem',
    backgroundColor: '#f1f5f9',
    borderRadius: '8px',
  },
  link: {
    color: 'var(--primary-color)',
    textDecoration: 'none',
    fontWeight: 500,
  },
  tableLink: {
    color: 'var(--primary-color)',
    textDecoration: 'underline',
    fontWeight: 500,
  },
  comparisonSection: {
    marginBottom: '2.5rem',
    backgroundColor: 'var(--card-background)',
    borderRadius: '12px',
    border: '1px solid var(--border-color)',
    padding: '1.5rem',
  },
  comparisonHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  downloadButton: {
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--primary-color)',
    backgroundColor: 'transparent',
    border: '1px solid var(--primary-color)',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'background-color 0.2s, color 0.2s',
  },
  tableContainer: {
    overflowX: 'auto',
  },
  comparisonTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.9rem',
  },
  tableTh: {
    padding: '0.75rem 1rem',
    textAlign: 'left',
    borderBottom: '2px solid var(--border-color)',
    color: 'var(--text-color)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  tableSubHeader: {
    display: 'block',
    fontWeight: 400,
    fontSize: '0.8rem',
    color: 'var(--subtle-text)'
  },
  tableTd: {
    padding: '0.75rem 1rem',
    borderBottom: '1px solid var(--border-color)',
    whiteSpace: 'nowrap',
  },
  tableTdKey: {
    padding: '0.75rem 1rem',
    borderBottom: '1px solid var(--border-color)',
    fontWeight: 500,
    color: '#334155',
  },
  highlightedCell: {
    backgroundColor: '#e0e7ff',
    fontWeight: 600,
    color: '#3730a3',
  },
  tabsContainer: {
    display: 'flex',
    borderBottom: '1px solid var(--border-color)',
    marginBottom: '2.5rem',
  },
  tabButton: {
    padding: '0.75rem 1.5rem',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: '1rem',
    color: 'var(--subtle-text)',
    fontWeight: 500,
    borderBottom: '2px solid transparent',
    marginBottom: '-1px',
  },
  tabButtonActive: {
    padding: '0.75rem 1.5rem',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: '1rem',
    color: 'var(--primary-color)',
    fontWeight: 600,
    borderBottom: '2px solid var(--primary-color)',
    marginBottom: '-1px',
  },
  tabContent: {},
  fileDropzone: {
    border: '2px dashed var(--border-color)',
    borderRadius: '8px',
    padding: '2rem',
    textAlign: 'center',
    backgroundColor: '#f8fafc',
    cursor: 'pointer',
    transition: 'background-color 0.2s, border-color 0.2s',
  },
  fileDropzoneLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    color: 'var(--subtle-text)',
    fontWeight: 500,
  },
  fileDropzoneSubtext: {
    fontSize: '0.875rem',
    color: '#94a3b8',
  },
  statusCellError: {
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    fontWeight: 600,
  },
  statusCellWarning: {
    backgroundColor: '#fef3c7',
    color: '#92400e',
    fontWeight: 600,
  },
  statusCellSuccess: {
    backgroundColor: '#dcfce7',
    color: '#166534',
    fontWeight: 600,
  },
  modeSwitcher: {
    display: 'flex',
    backgroundColor: '#eef2ff',
    borderRadius: '8px',
    padding: '0.25rem',
    marginBottom: '2rem',
  },
  modeButton: {
    flex: 1,
    padding: '0.5rem 1rem',
    border: 'none',
    background: 'transparent',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
    color: 'var(--subtle-text)',
    transition: 'background-color 0.2s, color 0.2s',
  },
  modeButtonActive: {
    flex: 1,
    padding: '0.5rem 1rem',
    border: 'none',
    background: 'var(--card-background)',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 600,
    color: 'var(--primary-color)',
    boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  },
  bulkTabsContainer: {
    border: '1px solid var(--border-color)',
    borderRadius: '12px',
    marginTop: '1rem',
    overflow: 'hidden',
  },
  bulkTabsNav: {
    display: 'flex',
    overflowX: 'auto',
    borderBottom: '1px solid var(--border-color)',
    backgroundColor: '#f8fafc',
  },
  bulkTabButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.75rem 1rem',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: '0.875rem',
    color: 'var(--subtle-text)',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    borderBottom: '2px solid transparent',
  },
  bulkTabButtonActive: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.75rem 1rem',
    border: 'none',
    background: 'var(--card-background)',
    cursor: 'pointer',
    fontSize: '0.875rem',
    color: 'var(--primary-color)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    borderBottom: '2px solid var(--primary-color)',
  },
  bulkTabButtonText: {
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    maxWidth: '150px',
  },
  bulkTabContent: {
    padding: '1.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  statusIconSuccess: {
    color: '#22c55e',
    fontSize: '1rem',
  },
  statusIconError: {
    color: '#ef4444',
    fontSize: '1rem',
  },
  statusBadgeBase: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.25rem 0.625rem',
    borderRadius: '9999px',
    fontSize: '0.8rem',
    fontWeight: 500,
  },
  statusBadgeSuccess: {
    backgroundColor: 'var(--status-success-bg)',
    color: 'var(--status-success-text)',
  },
  statusBadgeWarning: {
    backgroundColor: 'var(--status-warning-bg)',
    color: 'var(--status-warning-text)',
  },
  statusBadgeError: {
    backgroundColor: 'var(--status-error-bg)',
    color: 'var(--status-error-text)',
  },
  statusBadgeNeutral: {
    backgroundColor: 'var(--status-neutral-bg)',
    color: 'var(--status-neutral-text)',
  },
  recentSearchesContainer: {
    marginTop: '-1.5rem',
    marginBottom: '2.5rem',
  },
  recentSearchesHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem',
  },
  recentSearchesTitle: {
    margin: 0,
    fontSize: '0.875rem',
    color: 'var(--subtle-text)',
    fontWeight: 500,
  },
  recentSearchesList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  recentSearchButton: {
    padding: '0.25rem 0.75rem',
    fontSize: '0.875rem',
    backgroundColor: '#eef2ff',
    color: 'var(--primary-color)',
    border: '1px solid transparent',
    borderRadius: '9999px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  clearButton: {
    fontSize: '0.8rem',
    color: 'var(--subtle-text)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '0.25rem',
    textDecoration: 'underline',
    transition: 'color 0.2s',
  },
  // --- Chat styles ---
  chatContainer: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 250px)',
    maxHeight: '700px',
    backgroundColor: 'var(--card-background)',
    borderRadius: '12px',
    border: '1px solid var(--border-color)',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    overflow: 'hidden',
  },
  messageList: {
    flexGrow: 1,
    padding: '1.5rem',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: 'var(--primary-color)',
    color: 'white',
    padding: '0.75rem 1rem',
    borderRadius: '1.25rem 1.25rem 0.25rem 1.25rem',
    maxWidth: '80%',
    lineHeight: 1.5,
  },
  modelBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#f1f5f9',
    color: 'var(--text-color)',
    padding: '0.75rem 1rem',
    borderRadius: '1.25rem 1.25rem 1.25rem 0.25rem',
    maxWidth: '80%',
    lineHeight: 1.5,
  },
  chatInputForm: {
    display: 'flex',
    padding: '1rem',
    borderTop: '1px solid var(--border-color)',
    gap: '0.5rem',
  },
  chatInput: {
    flexGrow: 1,
    padding: '0.75rem 1rem',
    fontSize: '1rem',
    borderRadius: '9999px',
    border: '1px solid var(--border-color)',
    backgroundColor: 'var(--background-color)',
  },
  chatSendButton: {
    padding: '0.75rem 1.5rem',
    fontSize: '1rem',
    fontWeight: 500,
    color: '#fff',
    backgroundColor: 'var(--primary-color)',
    border: 'none',
    borderRadius: '9999px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  typingIndicator: {
    display: 'flex',
    gap: '0.25rem',
    alignItems: 'center',
    padding: '0.5rem 0',
  },
  promptSuggestionsContainer: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    padding: '0 1.5rem 1rem 1.5rem',
    borderTop: '1px solid var(--border-color)',
  },
  schematicContainer: {
    marginTop: '1rem',
    padding: '1rem',
    backgroundColor: 'var(--background-color)',
    borderRadius: '8px',
    border: '1px solid var(--border-color)',
  },
};

// --- RENDER APP ---
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<React.StrictMode><App /></React.StrictMode>);
