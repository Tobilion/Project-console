import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, ArrowUp, Plus, FileText, Code, BookOpen, PenTool, BrainCircuit, Sparkles, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

interface AIAssistantProps {
  onSend: (text: string) => void;
  onSearch?: (query: string) => void;
  onDeepResearch?: (query: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

// Files larger than this aren't useful to paste into a local model's context window —
// reject them client-side instead of silently truncating or hanging the request.
const MAX_UPLOAD_CHARS = 40000;
const READABLE_EXTENSIONS = /\.(txt|md|json|js|jsx|ts|tsx|css|html|py|java|c|cpp|h|cs|go|rs|rb|php|sql|yml|yaml|xml|sh|env|config|log|csv)$/i;

interface UploadedFile {
  name: string;
  content: string;
}

export function AIAssistantInterface({ onSend, onSearch, onDeepResearch, disabled, placeholder }: AIAssistantProps) {
  const [inputValue, setInputValue] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [activeFeature, setActiveFeature] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const suggestions: Record<string, string[]> = {
    projects: ['Give me an overview of this project', 'What is the tech stack?', 'What are the known gotchas?', 'Show me the project structure'],
    code: ['Find where X is defined', 'Add error handling to this function', 'Explain what this file does', 'Search the codebase for TODOs'],
    files: ['Write a new file called notes.md with...', 'Add a line to CLAUDE.md', 'Read the package.json', 'List all files in src/']
  };

  const buildOutgoingMessage = (text: string) => {
    if (uploadedFiles.length === 0) return text;
    const fileBlocks = uploadedFiles
      .map(f => `Attached file: ${f.name}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');
    return text ? `${fileBlocks}\n\n${text}` : fileBlocks;
  };

  const handleSend = () => {
    if ((inputValue.trim() || uploadedFiles.length > 0) && !disabled) {
      const text = inputValue.trim();
      if (activeFeature === 'search' && onSearch) {
        onSearch(text);
      } else if (activeFeature === 'deep-research' && onDeepResearch) {
        onDeepResearch(text);
      } else {
        const prefix = activeFeature === 'reason' ? '[REASON] ' : '';
        onSend(prefix + buildOutgoingMessage(text));
      }
      setInputValue('');
      setUploadedFiles([]);
      setActiveCategory(null);
      setActiveFeature(null);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file later
    if (files.length === 0) return;
    setUploadError(null);
    setIsReadingFile(true);

    let completed = 0;
    const errors: string[] = [];

    files.forEach((file) => {
      if (!READABLE_EXTENSIONS.test(file.name)) {
        errors.push(`"${file.name}" — not a readable file type (code, md, json, csv, etc).`);
        completed++;
        if (completed === files.length) { setIsReadingFile(false); if (errors.length > 0) setUploadError(errors.join('\n')); }
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const content = typeof reader.result === 'string' ? reader.result : '';
        if (content.length > MAX_UPLOAD_CHARS) {
          errors.push(`"${file.name}" is too large (${content.length.toLocaleString()} chars, max ${MAX_UPLOAD_CHARS.toLocaleString()}).`);
        } else {
          setUploadedFiles(prev => [...prev, { name: file.name, content }]);
        }
        completed++;
        if (completed === files.length) { setIsReadingFile(false); if (errors.length > 0) setUploadError(errors.join('\n')); }
      };
      reader.onerror = () => {
        errors.push(`Failed to read "${file.name}".`);
        completed++;
        if (completed === files.length) { setIsReadingFile(false); if (errors.length > 0) setUploadError(errors.join('\n')); }
      };
      reader.readAsText(file);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="w-full">
      <div className="bg-[#12151c]/80 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-sm">
        <div className="px-4 py-3">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder || 'Ask me anything...'}
            className="w-full bg-transparent text-gray-100 text-base outline-none placeholder:text-gray-600 font-mono"
          />
        </div>

        {uploadedFiles.length > 0 && (
          <div className="px-4 pb-2 flex flex-wrap gap-2">
            {uploadedFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-lg px-2 py-1">
                <FileText size={12} className="text-[#3d6bff]" />
                <span className="text-xs text-gray-400">{f.name}</span>
                <span className="text-[10px] text-gray-600">{f.content.length.toLocaleString()} chars</span>
                <button onClick={() => setUploadedFiles(prev => prev.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 transition-colors">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {uploadError && (
          <div className="px-4 pb-2">
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">
              <span className="text-xs text-red-400 flex-1">{uploadError}</span>
              <button onClick={() => setUploadError(null)} className="text-red-400/60 hover:text-red-400 transition-colors flex-shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        )}

        <div className="px-4 py-2.5 flex items-center justify-between border-t border-white/5">
          <div className="flex items-center gap-2">
            <ToggleButton icon={<Search size={14} />} label="Search" active={activeFeature === 'search'} onClick={() => setActiveFeature(activeFeature === 'search' ? null : 'search')} />
            <ToggleButton icon={<BrainCircuit size={14} />} label="Reason" active={activeFeature === 'reason'} onClick={() => setActiveFeature(activeFeature === 'reason' ? null : 'reason')} />
            <ToggleButton icon={<Sparkles size={14} />} label="Deep Research" active={activeFeature === 'deep-research'} onClick={() => setActiveFeature(activeFeature === 'deep-research' ? null : 'deep-research')} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSend}
              disabled={(!inputValue.trim() && uploadedFiles.length === 0) || !!disabled}
              className={cn('w-8 h-8 flex items-center justify-center rounded-full transition-all', (inputValue.trim() || uploadedFiles.length > 0) && !disabled ? 'bg-[#3d6bff] text-white hover:bg-[#3d6bff]/80' : 'bg-white/5 text-gray-600 cursor-not-allowed')}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>

        <div className="px-4 py-2 border-t border-white/5 flex items-center justify-between">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
            accept=".txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.html,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.sql,.yml,.yaml,.xml,.sh,.env,.config,.log,.csv"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isReadingFile}
            className="flex items-center gap-2 text-gray-500 text-sm hover:text-gray-300 transition-colors disabled:opacity-50"
          >
            {isReadingFile ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            <span className="text-xs">{isReadingFile ? 'Reading files...' : 'Upload Files (read into message)'}</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-3">
        {[
          { key: 'projects', icon: <BookOpen size={18} />, label: 'Project' },
          { key: 'code', icon: <Code size={18} />, label: 'Code' },
          { key: 'files', icon: <PenTool size={18} />, label: 'Files' }
        ].map(cat => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(activeCategory === cat.key ? null : cat.key)}
            className={cn('flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm transition-all', activeCategory === cat.key ? 'bg-[#3d6bff]/10 border-[#3d6bff]/30 text-[#3d6bff]' : 'bg-white/5 border-white/10 text-gray-400 hover:text-gray-200 hover:border-white/20')}
          >
            {cat.icon}
            <span className="text-xs font-medium">{cat.label}</span>
          </button>
        ))}
      </div>

      <AnimatePresence>
        {activeCategory && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mt-2">
            <div className="bg-[#12151c]/80 border border-white/10 rounded-xl overflow-hidden">
              <div className="px-3 py-2 border-b border-white/5">
                <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">{activeCategory} Suggestions</span>
              </div>
              <ul className="divide-y divide-white/5">
                {(suggestions[activeCategory] || []).map((s, i) => (
                  <motion.li key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.03 }}
                    onClick={() => { setInputValue(s); setActiveCategory(null); }}
                    className="px-3 py-2.5 hover:bg-white/5 cursor-pointer transition-colors flex items-center gap-3"
                  >
                    <BookOpen size={14} className="text-[#3d6bff]/60 flex-shrink-0" />
                    <span className="text-sm text-gray-300">{s}</span>
                  </motion.li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToggleButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn('flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono border transition-all', active ? 'bg-[#3d6bff]/20 border-[#3d6bff]/40 text-[#3d6bff]' : 'bg-white/5 border-white/10 text-gray-400 hover:text-gray-200 hover:border-white/20')}
    >
      {icon}
      <span>{label}</span>
      {active && (
        <span className="w-1.5 h-1.5 rounded-full bg-[#3d6bff] animate-pulse" />
      )}
    </button>
  );
}
