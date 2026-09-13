import { describe, it, expect } from 'vitest';
import { downloadBase64File } from './TakeoffStudio';
import type { ProcessResponse } from '@/lib/types';

describe('TakeoffStudio helpers', () => {
  it('downloadBase64File handles non-browser environment safely without throwing', () => {
    expect(() => {
      downloadBase64File('SGVsbG8gV29ybGQ=', 'test.txt', 'text/plain');
    }).not.toThrow();
  });

  it('can parse mock ProcessResponse shape correctly', () => {
    const mockResponse: ProcessResponse = {
      projectId: 'proj_12345678',
      status: 'complete',
      xlsxBase64: 'UEsDBBQAAAAIA',
      quoteBase64: 'JVBERi0xLjQK',
      extraction: {
        projectName: 'Test Subdivision',
        jobNumber: '2026-001',
        date: '2026-09-13',
        templateType: 'LONG',
        confidence: 0.95,
        warnings: [],
        catchbasins: {
          groups: [],
          laborRates: { scbLabor: 0, dcbLabor: 0, dicbFC: 0, ddicbFC: 0 },
        },
        sewers: [
          {
            item: 1,
            runLabel: 'STM 1-2',
            length: 50,
            pipeDiameter: 300,
            typeClass: 1,
            slope: 1.5,
            depth: 2.8,
            addMaterials: 1000,
            addLE: 500,
            isLineItem: false,
          },
          {
            item: 2,
            runLabel: 'SAN 1-2',
            length: 40,
            pipeDiameter: 200,
            typeClass: 1,
            slope: 0.5,
            depth: 3.2,
            addMaterials: 800,
            addLE: 400,
            isLineItem: false,
          },
        ],
        manholes: [
          {
            item: 1,
            description: 'STM MH 1',
            topElevation: 100.5,
            lowInvert: 97.2,
            highInvert: 97.5,
            pipeOutDiameter: 300,
            structureType: 'MH',
            depth: 3.3,
            diameter: 1200,
            drop: null,
            addMaterials: 3500,
            addLE: 1200,
          },
        ],
        watermain: [
          {
            item: 1,
            sizeAndType: '150mm PVC',
            length: 60,
            pipeDiameter: 150,
            ocSc: 1.1,
            addMaterials: 2000,
            addLE: 1000,
            avgCover: 2.1,
          },
        ],
        watermainValves: [
          {
            item: 1,
            valveSize: '150mm Gate Valve',
            quantity: 2,
            valveCost: 1200,
            boxCost: 400,
            anodeCost: 150,
            laborPerValve: 600,
          },
        ],
        watermainSpecials: [],
      },
    };

    expect(mockResponse.extraction.projectName).toBe('Test Subdivision');
    expect(mockResponse.extraction.sewers.length).toBe(2);
    expect(mockResponse.extraction.manholes.length).toBe(1);
  });
});
