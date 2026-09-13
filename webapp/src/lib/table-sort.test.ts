import { describe, it, expect } from 'vitest';
import { sortData, filterData } from './table-sort';

describe('table-sort', () => {
  interface TestItem {
    id: string;
    depth?: number | null;
    size: number;
    material?: string;
  }

  const items: TestItem[] = [
    { id: 'MH 1', depth: 3.5, size: 1200, material: 'Concrete' },
    { id: 'MH 10', depth: 2.1, size: 1500, material: 'PVC' },
    { id: 'CB 2', depth: 1.8, size: 600, material: 'HDPE' },
    { id: 'CB 1', depth: undefined, size: 450, material: 'Concrete' },
    { id: 'MH 2', depth: null, size: 900, material: 'pvc' },
  ];

  describe('sortData', () => {
    it('sorts numbers ascending and descending', () => {
      const validItems = items.filter((i) => typeof i.depth === 'number');
      const asc = sortData(validItems, 'depth', 'asc');
      expect(asc[0].id).toBe('CB 2');
      expect(asc[1].id).toBe('MH 10');
      expect(asc[2].id).toBe('MH 1');

      const desc = sortData(validItems, 'depth', 'desc');
      expect(desc[0].id).toBe('MH 1');
      expect(desc[1].id).toBe('MH 10');
      expect(desc[2].id).toBe('CB 2');
    });

    it('sorts strings case-insensitively', () => {
      const asc = sortData(items, 'material', 'asc');
      // 'Concrete', 'Concrete', 'HDPE', 'PVC'/'pvc'
      expect(asc[0].material?.toLowerCase()).toBe('concrete');
      expect(asc[1].material?.toLowerCase()).toBe('concrete');
      expect(asc[2].material?.toLowerCase()).toBe('hdpe');

      const desc = sortData(items, 'material', 'desc');
      expect(desc[0].material?.toLowerCase()).toBe('pvc');
      expect(desc[1].material?.toLowerCase()).toBe('pvc');
    });

    it('handles null and undefined values appropriately', () => {
      const asc = sortData(items, 'depth', 'asc');
      // In ascending, null/undefined come last
      expect(asc[0].depth).toBe(1.8);
      expect(asc[1].depth).toBe(2.1);
      expect(asc[2].depth).toBe(3.5);
      expect(asc[3].depth == null).toBe(true);
      expect(asc[4].depth == null).toBe(true);

      const desc = sortData(items, 'depth', 'desc');
      // In descending, null/undefined come first
      expect(desc[0].depth == null).toBe(true);
      expect(desc[1].depth == null).toBe(true);
      expect(desc[2].depth).toBe(3.5);
      expect(desc[3].depth).toBe(2.1);
      expect(desc[4].depth).toBe(1.8);
    });

    it('supports custom accessor functions for sorting', () => {
      const asc = sortData(items, (item) => item.size * 2, 'asc');
      expect(asc[0].id).toBe('CB 1'); // size 450
      expect(asc[asc.length - 1].id).toBe('MH 10'); // size 1500
    });

    it('returns empty array when input is empty', () => {
      const res = sortData([], 'id', 'asc');
      expect(res).toEqual([]);
    });
  });

  describe('filterData', () => {
    it('filters by multiple search fields', () => {
      const res = filterData(items, 'cb', ['id']);
      expect(res.length).toBe(2);
      expect(res.map((r) => r.id)).toContain('CB 2');
      expect(res.map((r) => r.id)).toContain('CB 1');
    });

    it('searches across both string and numeric fields', () => {
      const res = filterData(items, '1200', ['id', 'size']);
      expect(res.length).toBe(1);
      expect(res[0].id).toBe('MH 1');
    });

    it('returns all items when query is empty or only whitespace', () => {
      expect(filterData(items, '', ['id'])).toEqual(items);
      expect(filterData(items, '   ', ['id'])).toEqual(items);
    });

    it('supports custom accessor functions for filtering', () => {
      const res = filterData(
        items,
        'diameter-600',
        ['id', (item) => `diameter-${item.size}`]
      );
      expect(res.length).toBe(1);
      expect(res[0].id).toBe('CB 2');
    });

    it('returns empty array when no matches are found', () => {
      const res = filterData(items, 'nonexistent', ['id', 'material']);
      expect(res.length).toBe(0);
    });
  });
});
