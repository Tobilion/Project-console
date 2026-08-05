import { TerminalMessage } from '../types';

export function useSearch(setMessages: React.Dispatch<React.SetStateAction<TerminalMessage[]>>) {
  const handleSearch = async (query: string) => {
    const id = Date.now().toString();
    setMessages(prev => [...prev, { id, type: 'user', content: `Search: ${query}` }]);
    setMessages(prev => [...prev, { id: id + '-thinking', type: 'bot', content: 'Searching the web...' }]);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setMessages(prev => prev.filter(m => m.id !== id + '-thinking'));
      if (data.error) {
        setMessages(prev => [...prev, { id: id + '-result', type: 'error', content: `Search failed: ${data.error}` }]);
      } else if (Array.isArray(data) && data.length > 0) {
        const formatted = data.map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join('\n\n');
        setMessages(prev => [...prev, { id: id + '-result', type: 'bot', content: `### Web Search Results\n\n${formatted}`, isMarkdown: true }]);
      } else {
        setMessages(prev => [...prev, { id: id + '-result', type: 'bot', content: 'No search results found.' }]);
      }
    } catch (err: any) {
      setMessages(prev => prev.filter(m => m.id !== id + '-thinking'));
      setMessages(prev => [...prev, { id: id + '-result', type: 'error', content: `Search error: ${err.message}` }]);
    }
  };

  const handleDeepResearch = async (query: string) => {
    const id = Date.now().toString();
    setMessages(prev => [...prev, { id, type: 'user', content: `Deep Research: ${query}` }]);
    setMessages(prev => [...prev, { id: id + '-thinking', type: 'bot', content: 'Researching... this may take a moment.' }]);
    try {
      const res = await fetch(`/api/deep-research?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setMessages(prev => prev.filter(m => m.id !== id + '-thinking'));
      if (data.error) {
        setMessages(prev => [...prev, { id: id + '-result', type: 'error', content: `Research failed: ${data.error}` }]);
      } else {
        let msg = `### Deep Research: ${query}\n\n`;
        if (data.results?.length) {
          msg += '**Search Results:**\n\n';
          data.results.forEach((r: any, i: number) => {
            msg += `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}\n\n`;
          });
        }
        if (data.contents?.length) {
          msg += '**Key Content:**\n\n';
          data.contents.forEach((c: any) => {
            if (c.content) msg += `**${c.title}**\n${c.content.substring(0, 500)}...\n\n`;
          });
        }
        setMessages(prev => [...prev, { id: id + '-result', type: 'bot', content: msg, isMarkdown: true }]);
      }
    } catch (err: any) {
      setMessages(prev => prev.filter(m => m.id !== id + '-thinking'));
      setMessages(prev => [...prev, { id: id + '-result', type: 'error', content: `Research error: ${err.message}` }]);
    }
  };

  return { handleSearch, handleDeepResearch };
}
