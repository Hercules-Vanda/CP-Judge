/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Play, 
  Sparkles, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  AlertCircle, 
  Terminal, 
  Plus, 
  Trash2, 
  ChevronDown, 
  ChevronUp,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Initialize Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface TestCase {
  id: string;
  input: string;
  expectedOutput: string;
  actualOutput?: string;
  status?: 'pending' | 'running' | 'accepted' | 'wrong_answer' | 'tle' | 'compilation_error' | 'runtime_error' | 'error';
  errorDetails?: string;
  time?: string;
  memory?: string;
}

const JUDGE0_API_URL = "https://ce.judge0.com"; // Public CE instance
const LANGUAGE_ID = 54; // C++ (GCC 9.2.0)

export default function App() {
  const [problemStatement, setProblemStatement] = useState("");
  const [sampleInput, setSampleInput] = useState("");
  const [sampleOutput, setSampleOutput] = useState("");
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [code, setCode] = useState("// Paste your C++ code here\n#include <iostream>\nusing namespace std;\n\nint main() {\n    int a, b;\n    if (cin >> a >> b) {\n        cout << a + b << endl;\n    }\n    return 0;\n}");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [summary, setSummary] = useState<{ passed: number; total: number } | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Load sample into test cases initially
  useEffect(() => {
    if (sampleInput || sampleOutput) {
      // Only add if not already there or if it's the only one
      if (testCases.length === 0) {
        setTestCases([{
          id: 'sample',
          input: sampleInput,
          expectedOutput: sampleOutput,
          status: 'pending'
        }]);
      }
    }
  }, [sampleInput, sampleOutput]);

  const generateTestCases = async () => {
    if (!problemStatement) {
      setGlobalError("Please provide a problem statement first.");
      return;
    }
    setIsGenerating(true);
    setGlobalError(null);
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `You are an expert competitive programming judge. Analyze the following problem and provide 10 diverse, high-quality test cases.

Problem Statement:
${problemStatement}

Sample Input:
${sampleInput}

Sample Output:
${sampleOutput}

Requirements for Test Cases:
1. CRITICAL: The 'output' must be 100% mathematically and logically correct based on the problem rules. Double-check your logic (e.g., if it's a palindrome problem, verify the substring is actually a palindrome and is the longest).
2. Include boundary values (minimum and maximum constraints mentioned in the problem).
3. Include tricky edge cases (empty strings, single characters, all identical characters, no solution, multiple solutions of same length, etc.).
4. For large inputs, ensure the 'input' string/data matches the exact length or count you intended, and the 'output' reflects that exact data. Do not truncate or round counts.
5. Provide the test cases in a JSON array of objects with 'input' and 'output' fields.

Think step-by-step for each test case to ensure the expected output is accurate.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                input: { type: Type.STRING },
                output: { type: Type.STRING },
              },
              required: ["input", "output"],
            },
          },
        },
      });

      const generated = JSON.parse(response.text);
      const newTestCases: TestCase[] = generated.map((tc: any, index: number) => ({
        id: `gen-${Date.now()}-${index}`,
        input: tc.input,
        expectedOutput: tc.output,
        status: 'pending'
      }));

      // Keep sample at top
      const sample = {
        id: 'sample',
        input: sampleInput,
        expectedOutput: sampleOutput,
        status: 'pending' as const
      };

      setTestCases([sample, ...newTestCases]);
    } catch (error) {
      console.error("AI Generation Error:", error);
      setGlobalError("Failed to generate test cases. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  const runCode = async () => {
    if (!code) {
      setGlobalError("Please provide your C++ code.");
      return;
    }
    if (testCases.length === 0) {
      setGlobalError("No test cases to run.");
      return;
    }

    setIsRunning(true);
    setGlobalError(null);
    setSummary(null);

    // Reset test case statuses
    setTestCases(prev => prev.map(tc => ({ ...tc, status: 'pending', actualOutput: undefined, errorDetails: undefined })));

    let passedCount = 0;
    let compilationErrorOccurred = false;

    for (let i = 0; i < testCases.length; i++) {
      if (compilationErrorOccurred) break;

      const tc = testCases[i];
      setTestCases(prev => prev.map((t, idx) => idx === i ? { ...t, status: 'running' } : t));

      try {
        // 1. Submit
        const submitRes = await fetch(`${JUDGE0_API_URL}/submissions?base64_encoded=false&wait=false`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_code: code,
            language_id: LANGUAGE_ID,
            stdin: tc.input,
            expected_output: tc.expectedOutput,
            cpu_time_limit: 2.0
          })
        });

        if (!submitRes.ok) throw new Error("Judge0 submission failed");
        const { token } = await submitRes.json();

        // 2. Poll
        let result: any = null;
        while (true) {
          const pollRes = await fetch(`${JUDGE0_API_URL}/submissions/${token}?base64_encoded=false`);
          if (!pollRes.ok) throw new Error("Judge0 polling failed");
          result = await pollRes.json();

          if (result.status.id > 2) break; // Finished
          await new Promise(r => setTimeout(r, 1000));
        }

        // 3. Process Result
        const statusId = result.status.id;
        let status: TestCase['status'] = 'error';
        let errorDetails = result.compile_output || result.stderr || result.message;

        if (statusId === 3) {
          status = 'accepted';
          passedCount++;
        } else if (statusId === 4) {
          status = 'wrong_answer';
        } else if (statusId === 5) {
          status = 'tle';
        } else if (statusId === 6) {
          status = 'compilation_error';
          compilationErrorOccurred = true;
        } else if (statusId >= 7 && statusId <= 11) {
          status = 'runtime_error';
        }

        setTestCases(prev => prev.map((t, idx) => idx === i ? {
          ...t,
          status,
          actualOutput: result.stdout,
          errorDetails,
          time: result.time,
          memory: result.memory
        } : t));

      } catch (error) {
        console.error("Execution Error:", error);
        setTestCases(prev => prev.map((t, idx) => idx === i ? { ...t, status: 'error', errorDetails: "API Error" } : t));
        setGlobalError("Judge0 API is currently unreachable. Please try again later.");
        break;
      }
    }

    setSummary({ passed: passedCount, total: testCases.length });
    setIsRunning(false);
  };

  const updateTestCase = (id: string, field: 'input' | 'expectedOutput', value: string) => {
    setTestCases(prev => prev.map(tc => tc.id === id ? { ...tc, [field]: value } : tc));
  };

  const removeTestCase = (id: string) => {
    setTestCases(prev => prev.filter(tc => tc.id !== id));
  };

  const addTestCase = () => {
    setTestCases(prev => [...prev, {
      id: `manual-${Date.now()}`,
      input: "",
      expectedOutput: "",
      status: 'pending'
    }]);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100 font-sans p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-800 pb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-2">
              <Terminal className="text-blue-500" />
              CP Judge AI
            </h1>
            <p className="text-gray-400 mt-1">Competitive programming practice with AI test generation.</p>
          </div>
          {summary && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className={`px-6 py-3 rounded-xl border flex items-center gap-3 ${
                summary.passed === summary.total 
                  ? 'bg-green-500/10 border-green-500/50 text-green-400' 
                  : 'bg-yellow-500/10 border-yellow-500/50 text-yellow-400'
              }`}
            >
              <div className="text-2xl font-bold">{summary.passed} / {summary.total}</div>
              <div className="text-sm uppercase tracking-wider font-semibold">Test Cases Passed</div>
            </motion.div>
          )}
        </header>

        {globalError && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-lg flex items-center gap-3">
            <AlertCircle size={20} />
            {globalError}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column: Problem Input */}
          <section className="space-y-6">
            <div className="bg-[#141414] border border-gray-800 rounded-2xl p-6 space-y-4 shadow-xl">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <AlertCircle className="text-blue-400" size={20} />
                Problem Definition
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Problem Statement</label>
                  <textarea 
                    className="w-full bg-[#0a0a0a] border border-gray-800 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all h-40 resize-none font-mono"
                    placeholder="Describe the problem, constraints, and logic..."
                    value={problemStatement}
                    onChange={(e) => setProblemStatement(e.target.value)}
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Sample Input</label>
                    <textarea 
                      className="w-full bg-[#0a0a0a] border border-gray-800 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all h-32 resize-none font-mono"
                      placeholder="e.g. 2 3"
                      value={sampleInput}
                      onChange={(e) => setSampleInput(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Sample Output</label>
                    <textarea 
                      className="w-full bg-[#0a0a0a] border border-gray-800 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all h-32 resize-none font-mono"
                      placeholder="e.g. 5"
                      value={sampleOutput}
                      onChange={(e) => setSampleOutput(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <button 
                onClick={generateTestCases}
                disabled={isGenerating || !problemStatement}
                className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-900/20"
              >
                {isGenerating ? <Loader2 className="animate-spin" size={20} /> : <Sparkles size={20} />}
                {isGenerating ? "Analyzing Problem..." : "Generate Test Cases"}
              </button>
            </div>

            {/* Test Cases List */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold flex items-center gap-2">
                    <Terminal className="text-purple-400" size={20} />
                    Test Cases ({testCases.length})
                  </h2>
                  <span className="text-[10px] bg-purple-500/10 text-purple-400 px-2 py-0.5 rounded border border-purple-500/20">AI Assisted</span>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setTestCases([])}
                    className="text-xs text-gray-500 hover:text-red-400 transition-colors flex items-center gap-1 px-2 py-1 rounded hover:bg-red-500/5"
                  >
                    <Trash2 size={14} />
                    Clear All
                  </button>
                  <button 
                    onClick={addTestCase}
                    className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-white"
                  >
                    <Plus size={20} />
                  </button>
                </div>
              </div>

              <p className="text-[10px] text-gray-500 italic">
                Note: AI-generated outputs may occasionally be inaccurate for complex logic. Please verify and edit if needed.
              </p>

              <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                <AnimatePresence mode="popLayout">
                  {testCases.map((tc, index) => (
                    <motion.div 
                      key={tc.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className={`bg-[#141414] border rounded-xl p-4 space-y-3 transition-all ${
                        tc.status === 'accepted' ? 'border-green-500/30' : 
                        tc.status === 'wrong_answer' ? 'border-red-500/30' : 
                        tc.status === 'running' ? 'border-blue-500/30 animate-pulse' : 'border-gray-800'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-bold text-gray-600 bg-gray-800 px-2 py-1 rounded">#{index + 1}</span>
                          <StatusBadge status={tc.status} />
                        </div>
                        <button 
                          onClick={() => removeTestCase(tc.id)}
                          className="text-gray-600 hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-gray-500 uppercase font-bold mb-1 block">Input</label>
                          <textarea 
                            className="w-full bg-[#0a0a0a] border border-gray-800 rounded p-2 text-xs font-mono h-20 resize-none focus:border-blue-500 outline-none"
                            value={tc.input}
                            onChange={(e) => updateTestCase(tc.id, 'input', e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-gray-500 uppercase font-bold mb-1 block">Expected Output</label>
                          <textarea 
                            className="w-full bg-[#0a0a0a] border border-gray-800 rounded p-2 text-xs font-mono h-20 resize-none focus:border-blue-500 outline-none"
                            value={tc.expectedOutput}
                            onChange={(e) => updateTestCase(tc.id, 'expectedOutput', e.target.value)}
                          />
                        </div>
                      </div>

                      {tc.actualOutput !== undefined && (
                        <div className="pt-2 border-t border-gray-800">
                          <label className="text-[10px] text-gray-500 uppercase font-bold mb-1 block">Actual Output</label>
                          <pre className="bg-[#0a0a0a] p-2 rounded text-xs font-mono text-gray-300 overflow-x-auto">
                            {tc.actualOutput || (tc.status === 'accepted' ? tc.expectedOutput : "(No Output)")}
                          </pre>
                        </div>
                      )}

                      {tc.errorDetails && (
                        <div className="pt-2 border-t border-gray-800">
                          <label className="text-[10px] text-red-500 uppercase font-bold mb-1 block">Error Details</label>
                          <pre className="bg-red-500/5 p-2 rounded text-xs font-mono text-red-400 overflow-x-auto whitespace-pre-wrap">
                            {tc.errorDetails}
                          </pre>
                        </div>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </section>

          {/* Right Column: Code Submission */}
          <section className="space-y-6">
            <div className="bg-[#141414] border border-gray-800 rounded-2xl p-6 space-y-4 shadow-xl sticky top-8">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                  <Terminal className="text-green-400" size={20} />
                  C++ Solution
                </h2>
                <div className="text-xs text-gray-500 font-mono">GCC 9.2.0</div>
              </div>

              <div className="relative group">
                <textarea 
                  className="w-full bg-[#0a0a0a] border border-gray-800 rounded-xl p-4 text-sm font-mono h-[500px] focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all resize-none leading-relaxed"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  spellCheck={false}
                />
                <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-[10px] bg-gray-800 text-gray-400 px-2 py-1 rounded">C++</span>
                </div>
              </div>

              <button 
                onClick={runCode}
                disabled={isRunning || testCases.length === 0}
                className="w-full py-4 bg-green-600 hover:bg-green-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-green-900/20 text-lg"
              >
                {isRunning ? <Loader2 className="animate-spin" size={24} /> : <Play size={24} />}
                {isRunning ? "Judging..." : "Run Code"}
              </button>

              <div className="grid grid-cols-2 gap-4 text-center">
                <div className="bg-[#0a0a0a] p-3 rounded-xl border border-gray-800">
                  <div className="text-[10px] text-gray-500 uppercase font-bold mb-1">Time Limit</div>
                  <div className="text-sm font-mono text-blue-400">2.0s</div>
                </div>
                <div className="bg-[#0a0a0a] p-3 rounded-xl border border-gray-800">
                  <div className="text-[10px] text-gray-500 uppercase font-bold mb-1">Memory Limit</div>
                  <div className="text-sm font-mono text-blue-400">128MB</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #0a0a0a;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #333;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #444;
        }
      `}</style>
    </div>
  );
}

function StatusBadge({ status }: { status?: TestCase['status'] }) {
  switch (status) {
    case 'running':
      return <span className="flex items-center gap-1 text-[10px] font-bold text-blue-400 uppercase tracking-wider"><Loader2 size={12} className="animate-spin" /> Running</span>;
    case 'accepted':
      return <span className="flex items-center gap-1 text-[10px] font-bold text-green-400 uppercase tracking-wider"><CheckCircle2 size={12} /> Accepted</span>;
    case 'wrong_answer':
      return <span className="flex items-center gap-1 text-[10px] font-bold text-red-400 uppercase tracking-wider"><XCircle size={12} /> Wrong Answer</span>;
    case 'tle':
      return <span className="flex items-center gap-1 text-[10px] font-bold text-yellow-400 uppercase tracking-wider"><Clock size={12} /> TLE</span>;
    case 'compilation_error':
      return <span className="flex items-center gap-1 text-[10px] font-bold text-orange-400 uppercase tracking-wider"><AlertCircle size={12} /> Compile Error</span>;
    case 'runtime_error':
      return <span className="flex items-center gap-1 text-[10px] font-bold text-red-500 uppercase tracking-wider"><AlertCircle size={12} /> Runtime Error</span>;
    case 'error':
      return <span className="flex items-center gap-1 text-[10px] font-bold text-gray-500 uppercase tracking-wider"><AlertCircle size={12} /> Error</span>;
    default:
      return <span className="flex items-center gap-1 text-[10px] font-bold text-gray-600 uppercase tracking-wider">Pending</span>;
  }
}
