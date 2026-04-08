import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

const STATUS_FLOW = ["received", "diagnosing", "waiting_parts", "in_progress", "completed", "delivered", "invoiced"];
const STATUS_LABELS = {
  received: "Received", diagnosing: "Diagnosing", waiting_parts: "Waiting Parts",
  in_progress: "In Progress", completed: "Completed", delivered: "Delivered", invoiced: "Invoiced",
};

/* ═══════════════════════════════════════════════════════════
   NEW JOB FORM — /workshop/new-job
   ═══════════════════════════════════════════════════════════ */
export function NewJobPage() {
  const nav = useNavigate();
  const [plateSearch, setPlateSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [showNewVehicle, setShowNewVehicle] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // New vehicle fields
  const [plate, setPlate] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [color, setColor] = useState("");
  const [custName, setCustName] = useState("");
  const [custPhone, setCustPhone] = useState("");

  // Job fields
  const [complaint, setComplaint] = useState("");
  const [mechanic, setMechanic] = useState("");
  const [estDate, setEstDate] = useState("");
  const [estCost, setEstCost] = useState("");

  const searchPlate = async (val) => {
    setPlateSearch(val);
    if (val.length >= 2) {
      try {
        const res = await api.get("/workshop/vehicles/search", { params: { plate: val } });
        setSearchResults(res.data);
      } catch { setSearchResults([]); }
    } else {
      setSearchResults([]);
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError("");
    try {
      let vehicleId = selectedVehicle?.id;

      // Create vehicle if new
      if (!vehicleId && showNewVehicle) {
        const vRes = await api.post("/workshop/vehicles", {
          plate_number: plate, make, model, year: year ? parseInt(year) : null,
          color, customer_name: custName, customer_phone: custPhone,
        });
        vehicleId = vRes.data.id;
      }

      if (!vehicleId) {
        setError("Please select or create a vehicle");
        setSaving(false);
        return;
      }

      const res = await api.post("/workshop/jobs", {
        vehicle_id: vehicleId,
        complaint_description: complaint,
        assigned_mechanic: mechanic || null,
        estimated_completion: estDate || null,
        estimated_cost: estCost ? parseFloat(estCost) : null,
      });
      nav(`/workshop/job/${res.data.id}`);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to create job");
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <FadeIn>
        <h1 className="text-2xl font-bold dark:text-white">🔧 New Job Card</h1>
      </FadeIn>

      {/* Vehicle Search */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700">
        <h2 className="font-bold dark:text-white mb-3">Vehicle</h2>

        {!selectedVehicle && !showNewVehicle && (
          <>
            <input type="text" placeholder="Search by plate number..." className={inputClass}
              value={plateSearch} onChange={e => searchPlate(e.target.value)} />

            {searchResults.length > 0 && (
              <div className="mt-2 border dark:border-gray-700 rounded-xl overflow-hidden">
                {searchResults.map(v => (
                  <button key={v.id} onClick={() => { setSelectedVehicle(v); setSearchResults([]); }}
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 border-b dark:border-gray-700 last:border-0">
                    <span className="font-bold dark:text-white">{v.plate_number}</span>
                    <span className="text-gray-500 dark:text-gray-400 ml-2">{v.make} {v.model} — {v.customer_name}</span>
                  </button>
                ))}
              </div>
            )}

            <button onClick={() => setShowNewVehicle(true)}
              className="mt-3 text-sm text-blue-600 dark:text-blue-400 hover:underline">
              + Register new vehicle
            </button>
          </>
        )}

        {selectedVehicle && (
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4">
            <div className="flex justify-between">
              <div>
                <p className="font-bold text-lg dark:text-white">{selectedVehicle.plate_number}</p>
                <p className="text-sm text-gray-600 dark:text-gray-300">{selectedVehicle.make} {selectedVehicle.model} {selectedVehicle.color}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">{selectedVehicle.customer_name} — {selectedVehicle.customer_phone}</p>
              </div>
              <button onClick={() => setSelectedVehicle(null)} className="text-xs text-red-500 hover:underline">Change</button>
            </div>
          </div>
        )}

        {showNewVehicle && !selectedVehicle && (
          <div className="space-y-3 mt-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Plate Number *</label>
                <input type="text" className={inputClass} value={plate} onChange={e => setPlate(e.target.value)} placeholder="BA 1 PA 1234" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Make</label>
                <input type="text" className={inputClass} value={make} onChange={e => setMake(e.target.value)} placeholder="Toyota, Bajaj..." />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Model</label>
                <input type="text" className={inputClass} value={model} onChange={e => setModel(e.target.value)} placeholder="Corolla" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Year</label>
                <input type="number" className={inputClass} value={year} onChange={e => setYear(e.target.value)} placeholder="2020" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Color</label>
                <input type="text" className={inputClass} value={color} onChange={e => setColor(e.target.value)} placeholder="White" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Customer Name</label>
                <input type="text" className={inputClass} value={custName} onChange={e => setCustName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Phone</label>
                <input type="text" className={inputClass} value={custPhone} onChange={e => setCustPhone(e.target.value)} />
              </div>
            </div>
            <button onClick={() => setShowNewVehicle(false)} className="text-xs text-gray-400 hover:underline">Cancel — search instead</button>
          </div>
        )}
      </div>

      {/* Job Details */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 space-y-4">
        <h2 className="font-bold dark:text-white">Job Details</h2>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Complaint / Issue</label>
          <textarea className={inputClass} rows={3} value={complaint} onChange={e => setComplaint(e.target.value)}
            placeholder="Describe the customer's complaint or requested service..." />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Assign Mechanic</label>
            <input type="text" className={inputClass} value={mechanic} onChange={e => setMechanic(e.target.value)} placeholder="Mechanic name" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Est. Completion</label>
            <input type="date" className={inputClass} value={estDate} onChange={e => setEstDate(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Estimated Cost</label>
          <input type="number" className={inputClass} value={estCost} onChange={e => setEstCost(e.target.value)} placeholder="0" />
        </div>
      </div>

      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}

      <button onClick={handleSubmit} disabled={saving}
        className="w-full py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold transition disabled:opacity-50">
        {saving ? "Creating..." : "Create Job Card"}
      </button>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   JOB CARD DETAIL — /workshop/job/:id
   ═══════════════════════════════════════════════════════════ */
export default function JobCardPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const nav = useNavigate();

  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("parts");
  const [error, setError] = useState("");

  // Add part form
  const [partName, setPartName] = useState("");
  const [partQty, setPartQty] = useState("1");
  const [partCost, setPartCost] = useState("");
  const [partFromStock, setPartFromStock] = useState(false);

  // Add labor form
  const [laborDesc, setLaborDesc] = useState("");
  const [laborMechanic, setLaborMechanic] = useState("");
  const [laborHours, setLaborHours] = useState("");
  const [laborRate, setLaborRate] = useState("");

  const fetchJob = () => {
    api.get(`/workshop/jobs/${id}`).then(r => setJob(r.data)).catch(() => nav("/workshop")).finally(() => setLoading(false));
  };
  useEffect(fetchJob, [id]);

  const updateStatus = async (newStatus) => {
    try {
      await api.patch(`/workshop/jobs/${id}/status`, { status: newStatus });
      fetchJob();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update");
    }
  };

  const addPart = async () => {
    if (!partName || !partCost) return;
    try {
      await api.post(`/workshop/jobs/${id}/parts`, {
        part_name: partName, quantity: parseFloat(partQty) || 1,
        unit_cost: parseFloat(partCost) || 0, is_from_stock: partFromStock,
      });
      setPartName(""); setPartQty("1"); setPartCost(""); setPartFromStock(false);
      fetchJob();
    } catch (err) { setError(err.response?.data?.detail || "Failed"); }
  };

  const addLabor = async () => {
    if (!laborDesc || !laborHours) return;
    try {
      await api.post(`/workshop/jobs/${id}/labor`, {
        description: laborDesc, mechanic_name: laborMechanic || null,
        hours: parseFloat(laborHours) || 0, hourly_rate: parseFloat(laborRate) || 0,
      });
      setLaborDesc(""); setLaborMechanic(""); setLaborHours(""); setLaborRate("");
      fetchJob();
    } catch (err) { setError(err.response?.data?.detail || "Failed"); }
  };

  if (loading) return <div className="p-8 text-center text-gray-400">Loading...</div>;
  if (!job) return <div className="p-8 text-center text-gray-400">Job not found</div>;

  const currentIdx = STATUS_FLOW.indexOf(job.status);
  const inputClass = "w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <FadeIn>
        <div className="flex items-start justify-between">
          <div>
            <button onClick={() => nav("/workshop")} className="text-sm text-blue-600 dark:text-blue-400 hover:underline mb-1">← Back</button>
            <h1 className="text-2xl font-bold dark:text-white">{job.job_number}</h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm">{job.vehicle?.plate_number} — {job.vehicle?.make} {job.vehicle?.model}</p>
            {job.vehicle?.customer_name && <p className="text-sm text-gray-400">{job.vehicle.customer_name} · {job.vehicle?.customer_phone}</p>}
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">{job.grand_total?.toLocaleString()} {currency}</p>
            <p className="text-xs text-gray-400">Parts: {job.parts_total?.toLocaleString()} + Labor: {job.labor_total?.toLocaleString()}</p>
          </div>
        </div>
      </FadeIn>

      {/* Status Timeline */}
      <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border dark:border-gray-700 overflow-x-auto">
        <div className="flex items-center gap-1 min-w-[600px]">
          {STATUS_FLOW.map((s, i) => (
            <div key={s} className="flex items-center flex-1">
              <button onClick={() => updateStatus(s)} title={`Set to ${STATUS_LABELS[s]}`}
                className={`w-full py-1.5 text-xs font-medium rounded-lg transition ${
                  i <= currentIdx
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}>
                {STATUS_LABELS[s]}
              </button>
              {i < STATUS_FLOW.length - 1 && <span className="text-gray-300 dark:text-gray-600 mx-0.5">→</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Complaint & Diagnosis */}
      {(job.complaint_description || job.diagnosis) && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border dark:border-gray-700 space-y-2">
          {job.complaint_description && (
            <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Complaint:</span>
              <p className="text-sm dark:text-gray-300">{job.complaint_description}</p></div>
          )}
          {job.diagnosis && (
            <div><span className="text-xs font-medium text-gray-500 dark:text-gray-400">Diagnosis:</span>
              <p className="text-sm dark:text-gray-300">{job.diagnosis}</p></div>
          )}
        </div>
      )}

      {/* Parts & Labor Tabs */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl border dark:border-gray-700 overflow-hidden">
        <div className="flex border-b dark:border-gray-700">
          <button onClick={() => setActiveTab("parts")}
            className={`flex-1 py-3 text-sm font-medium ${activeTab === "parts" ? "border-b-2 border-blue-600 text-blue-600" : "text-gray-400"}`}>
            🔩 Parts ({job.parts?.length || 0})
          </button>
          <button onClick={() => setActiveTab("labor")}
            className={`flex-1 py-3 text-sm font-medium ${activeTab === "labor" ? "border-b-2 border-blue-600 text-blue-600" : "text-gray-400"}`}>
            🛠️ Labor ({job.labor?.length || 0})
          </button>
        </div>

        <div className="p-4">
          {activeTab === "parts" && (
            <div className="space-y-3">
              {job.parts?.map(p => (
                <div key={p.id} className="flex justify-between items-center text-sm py-2 border-b dark:border-gray-700 last:border-0">
                  <div>
                    <p className="font-medium dark:text-white">{p.part_name}</p>
                    <p className="text-xs text-gray-400">{p.quantity} × {p.unit_cost.toLocaleString()} {currency}
                      {p.is_from_stock && " · from stock"}</p>
                  </div>
                  <span className="font-semibold dark:text-white">{p.total_cost.toLocaleString()} {currency}</span>
                </div>
              ))}
              {/* Add part form */}
              <div className="pt-3 border-t dark:border-gray-700 space-y-2">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Add Part</p>
                <div className="grid grid-cols-3 gap-2">
                  <input type="text" className={inputClass} placeholder="Part name" value={partName} onChange={e => setPartName(e.target.value)} />
                  <input type="number" className={inputClass} placeholder="Qty" value={partQty} onChange={e => setPartQty(e.target.value)} />
                  <input type="number" className={inputClass} placeholder="Unit cost" value={partCost} onChange={e => setPartCost(e.target.value)} />
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <input type="checkbox" checked={partFromStock} onChange={e => setPartFromStock(e.target.checked)} /> From stock (auto-deduct)
                  </label>
                  <button onClick={addPart} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Add</button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "labor" && (
            <div className="space-y-3">
              {job.labor?.map(l => (
                <div key={l.id} className="flex justify-between items-center text-sm py-2 border-b dark:border-gray-700 last:border-0">
                  <div>
                    <p className="font-medium dark:text-white">{l.description}</p>
                    <p className="text-xs text-gray-400">{l.mechanic_name} · {l.hours}h × {l.hourly_rate.toLocaleString()} {currency}/hr</p>
                  </div>
                  <span className="font-semibold dark:text-white">{l.total_cost.toLocaleString()} {currency}</span>
                </div>
              ))}
              {/* Add labor form */}
              <div className="pt-3 border-t dark:border-gray-700 space-y-2">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Add Labor</p>
                <input type="text" className={inputClass} placeholder="Work description" value={laborDesc} onChange={e => setLaborDesc(e.target.value)} />
                <div className="grid grid-cols-3 gap-2">
                  <input type="text" className={inputClass} placeholder="Mechanic" value={laborMechanic} onChange={e => setLaborMechanic(e.target.value)} />
                  <input type="number" className={inputClass} placeholder="Hours" value={laborHours} onChange={e => setLaborHours(e.target.value)} />
                  <input type="number" className={inputClass} placeholder="Rate/hr" value={laborRate} onChange={e => setLaborRate(e.target.value)} />
                </div>
                <div className="text-right">
                  <button onClick={addLabor} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Add</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Running total */}
        <div className="bg-gray-50 dark:bg-gray-700/50 px-4 py-3 border-t dark:border-gray-700">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">Parts</span>
            <span className="dark:text-gray-300">{job.parts_total?.toLocaleString()} {currency}</span>
          </div>
          <div className="flex justify-between text-sm mt-1">
            <span className="text-gray-500 dark:text-gray-400">Labor</span>
            <span className="dark:text-gray-300">{job.labor_total?.toLocaleString()} {currency}</span>
          </div>
          <div className="flex justify-between font-bold text-lg mt-2 pt-2 border-t dark:border-gray-600 dark:text-white">
            <span>Total</span>
            <span>{job.grand_total?.toLocaleString()} {currency}</span>
          </div>
        </div>
      </div>

      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}
    </div>
  );
}
