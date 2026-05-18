// Default global parameters matching the template header cells
export const DEFAULT_PARAMS = {
  // MANHOLES defaults
  manholes: {
    truckingPerCM: 10,
    concretePerCM: 250,
    discount: 0.35,
    marginFactor: 1.1,
    fstFactor: 1,
    pstFactor: 1,
    modPerM: 718,
    mhFC: 375,
    cbFC: 500,
    laborPerHr: 110,
    frameCoverM: 0.3,
    metric: true, // 1 = metric, 0 = imperial
  },
  // SEWERS defaults
  sewers: {
    minTrenchWidth: 1.2,
    pipeCover: 0.3,
    mFinGrade: 0,
    dayCostPerDay: 9000,
    extraPerDay: 300,
    productionMPerDay: 65,
    stoneImpT: 22,
    stoneMt: 35,
    granImpTn: 10,
    granMt: 30,
    truckingPerCM: 10,
    efficiency: 100,
    metric: true,
    marginFactor: 1.1,
    openCutFactor: 0.9,
    dualTrSep: 0.8,
    trenchClear: 0.3,
    concPipePct: 25,
    provTax: 1,
    fedTax: 1,
    // Pipe prices per meter
    pvc100: 0, // auto-looked up from table
    pvc150: 0,
    pvc200: 0,
    pvc250: 0,
    pvc300: 0,
    pvc375: 0,
    pvc450: 0,
  },
  // WATERMAIN defaults
  watermain: {
    minTrenchWidth: 1.2,
    pipeCover: 0.3,
    mFinGrade: 0,
    dayCostPerDay: 9000,
    extraPerDay: 300,
    productionMPerDay: 65,
    stoneImpTon: 22,
    stoneMtne: 35,
    granImpTon: 10,
    granMtne: 30,
    truckingPerCM: 10,
    efficiency: 100,
    metric: true,
    marginFactor: 1.1,
    openCutFactor: 0.9,
    dualTrSep: 1,
    trenchClear: 0.15,
    peelRegionCover: 0,
    precastPct: 5,
    provTax: 1,
    fedTax: 1,
    modulocPerM: 620,
    // Pipe prices C900
    c900_100: 32,
    c900_150: 51,
    c900_200: 84,
    c900_250: 156,
    c900_300: 194,
    concPerCM: 250,
  },
};

// Which cells in each sheet are INPUT (user-provided) vs FORMULA (auto-calculated)
export const INPUT_CELLS = {
  'MANHOLES (1)': {
    header: {
      B2: 'projectName',
      B3: 'jobNumber',
      B5: 'date',
      F3: 'truckingPerCM',
      F4: 'concretePerCM',
      F5: 'discount',
      F6: 'marginFactor',
      F7: 'metric', // 1 or 0
      I3: 'fstFactor',
      I4: 'pstFactor',
      I5: 'modPerM',
      I6: 'mhFC',
      I7: 'cbFC',
      L4: 'laborPerHr',
      L7: 'frameCoverM',
    },
    // Data rows start at row 11, columns for each manhole:
    dataStartRow: 11,
    dataEndRow: 50, // Changed from 60 to 50 to match the template (manholes stop at row 50)
    dataColumns: {
      B: 'description',
      C: 'topElevation',
      D: 'lowInvert',
      E: 'highInvert',
      F: 'pipeOutDiameter',
      G: 'structureType', // 1=STD, 2=LRG
      H: 'addMaterials',
      I: 'addLE',
      J: 'depth', // Added depth to input cells
      K: 'drop', // Added drop to input cells
      L: 'diameter', // Added diameter to input cells
    },
  },
  'SEWERS (1)': {
    header: {
      F3: 'minTrenchWidth',
      F4: 'pipeCover',
      F5: 'mFinGrade',
      F6: 'dayCostPerDay',
      F7: 'extraPerDay',
      F8: 'productionMPerDay',
      I3: 'stoneImpT',
      I4: 'stoneMt',
      I5: 'granImpTn',
      I6: 'granMt',
      I7: 'truckingPerCM',
      P3: 'efficiency',
      P4: 'metric',
      P5: 'marginFactor',
      P6: 'openCutFactor',
      P7: 'dualTrSep',
      P8: 'concPipePct',
      P9: 'trenchClear',
      V3: 'provTax',
      V4: 'fedTax',
    },
    dataStartRow: 14,
    dataEndRow: 55,
    dataColumns: {
      B: 'runLabel',
      C: 'length',
      D: 'pipeDiameter',
      E: 'typeClass',
      F: 'slope',
      G: 'depth',
      H: 'addMaterials',
      I: 'addLE',
    },
  },
  'WATERMAIN (1)': {
    header: {
      F3: 'minTrenchWidth',
      F4: 'pipeCover',
      F5: 'mFinGrade',
      F6: 'dayCostPerDay',
      F7: 'extraPerDay',
      F8: 'productionMPerDay',
      I3: 'stoneImpTon',
      I4: 'stoneMtne',
      I5: 'granImpTon',
      I6: 'granMtne',
      I7: 'truckingPerCM',
      I8: 'peelRegionCover',
      O3: 'efficiency',
      O4: 'metric',
      O6: 'openCutFactor',
      O7: 'dualTrSep',
      O8: 'trenchClear',
      R4: 'precastPct',
      R7: 'modulocPerM',
      L3: 'c900_100',
      L4: 'c900_150',
      L5: 'c900_200',
      L6: 'c900_250',
      L7: 'c900_300',
      L8: 'concPerCM',
      U3: 'provTax',
      U4: 'fedTax',
    },
    dataStartRow: 13,
    dataEndRow: 19,
    dataColumns: {
      B: 'sizeAndType',
      C: 'length',
      D: 'pipeDiameter',
      F: 'ocSc', // 1.1=OC single, 1.2=OC dual, 2.1=SC single, 2.2=SC dual
      G: 'addMaterials',
      H: 'addLE',
      J: 'avgCover',
    },
    // Specials section starts at row 24
    specialsStartRow: 24,
    specialsColumns: {
      B: 'specialName',
      C: 'quantity',
      D: 'costEach',
      E: 'thrustBlock', // 1=yes, 0=no
      F: 'anodeCost',
      G: 'laborEach',
    },
    // Valves section
    valvesColumns: {
      O: 'valveSize',
      P: 'quantity',
      Q: 'valveCost',
      R: 'boxCost',
      S: 'anodeCost',
      T: 'laborPerValve',
    },
  },
};

// Template selection thresholds
export const TEMPLATE_THRESHOLDS = {
  SHORT: {
    maxSewerRuns: 40,
    maxManholes: 50,
    maxWatermainRuns: 6,
  },
};

export const PIPE_DIAMETERS = [100, 150, 200, 250, 300, 375, 450, 525, 600, 675, 750, 900, 1050, 1200, 1350, 1500, 1650, 1800];

export const MH_DIAMETERS = [900, 1200, 1500, 1800, 2400];
