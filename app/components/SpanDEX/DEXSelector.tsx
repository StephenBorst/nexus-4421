import React from 'react';

const DEXES = [
  { id: 'fabric', name: 'Fabric', desc: 'Best prices' },
  { id: '0x', name: '0x', desc: 'Multi-chain' },
  { id: 'kyber', name: 'Kyber', desc: 'Dynamic MM' },
  { id: 'odos', name: 'Odos', desc: 'Intent-based' },
];

export const DEXSelector: React.FC<{ selected: string[]; onChange: (s: string[]) => void }> = ({ selected, onChange }) => {
  return (
    <div className="p-4 bg-slate-800 rounded-lg border border-slate-700">
      <h3 className="font-semibold text-gray-200 mb-3">Select DEXes</h3>
      {DEXES.map(dex => (
        <label key={dex.id} className="flex items-center gap-2 p-2 cursor-pointer hover:bg-slate-700">
          <input 
            type="checkbox" 
            checked={selected.includes(dex.id)} 
            onChange={() => onChange(selected.includes(dex.id) ? selected.filter(s => s !== dex.id) : [...selected, dex.id])} 
            className="w-4 h-4"
          />
          <div>
            <div className="text-gray-200 font-medium">{dex.name}</div>
            <div className="text-xs text-gray-400">{dex.desc}</div>
          </div>
        </label>
      ))}
    </div>
  );
};
