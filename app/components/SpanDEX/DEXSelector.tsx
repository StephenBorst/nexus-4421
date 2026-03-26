import React from 'react';

const AGGREGATORS = [
  { id: 'fabric', name: 'Fabric', description: 'Best prices with MEV protection' },
  { id: '0x', name: '0x', description: 'Multi-chain DEX aggregator' },
  { id: 'kyber', name: 'Kyber', description: 'Dynamic market maker' },
  { id: 'odos', name: 'Odos', description: 'Intent-based aggregator' },
];

interface DEXSelectorProps {
  selected: string[];
  onChange: (selected: string[]) => void;
}

export const DEXSelector: React.FC<DEXSelectorProps> = ({ selected, onChange }) => {
  const handleToggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id]);
  };

  return (
    <div className="p-4 bg-slate-800 rounded-lg border border-slate-700">
      <h3 className="font-semibold text-gray-200 mb-3">Select Aggregators</h3>
      <div className="space-y-2">
        {AGGREGATORS.map(agg => (
          <label key={agg.id} className="flex items-center gap-3 p-2 rounded hover:bg-slate-700/50 cursor-pointer">
            <input type="checkbox" checked={selected.includes(agg.id)} onChange={() => handleToggle(agg.id)} className="w-4 h-4" />
            <div>
              <div className="font-medium text-gray-200">{agg.name}</div>
              <div className="text-xs text-gray-400">{agg.description}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
};
