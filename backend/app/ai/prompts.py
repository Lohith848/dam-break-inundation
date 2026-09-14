"""
prompts.py
----------
Reusable prompt templates for the AI Copilot.

All prompts are stored here — never hardcoded in routes.
Each prompt is a function that takes simulation data and returns
the system + user prompt pair.
"""

from typing import Dict, Optional


# ---------------------------------------------------------------------------
# System Prompts
# ---------------------------------------------------------------------------

SYSTEM_PERSONA = """You are a senior hydrologist and disaster management engineer with 20+ years of experience in dam safety analysis and flood risk assessment. You work for the National Dam Safety Authority.

CRITICAL RULES:
- NEVER fabricate numbers, village names, or flood depths.
- NEVER invent data that is not provided in the simulation results.
- NEVER modify or override simulation outputs.
- ONLY explain and interpret the data provided to you.
- If information is unavailable, explicitly state: "This information is not available in the current simulation data."
- Use metric units consistently (metres, km², m³/s, hours, minutes).
- Be precise, professional, and suitable for government officials and engineers.
- Format responses with clear structure using headers and bullet points.
- Reference specific numbers from the simulation data when making observations."""


# ---------------------------------------------------------------------------
# Analysis Prompts
# ---------------------------------------------------------------------------

def build_analysis_prompt(sim_data: dict) -> tuple:
    """
    Build system + user prompt for comprehensive simulation analysis.

    Returns (system_prompt, user_prompt).
    """
    # Extract key data
    breach = sim_data.get("breach", {})
    summary = sim_data.get("summary", {})
    dam_geom = sim_data.get("dam_geometry", {})
    elev_stats = sim_data.get("elevation_stats", {})
    dam_name = sim_data.get("dam_name", "Unknown Dam")
    dam_location = sim_data.get("dam_location", {})

    pois = summary.get("points_of_interest", [])
    poi_text = ""
    for poi in pois:
        arrival = f"{poi.get('arrival_time_min', 'N/A')} min" if poi.get("arrival_time_min") is not None else "Not reached"
        poi_text += f"  - {poi.get('name', 'Unknown')}: arrival={arrival}, peak_depth={poi.get('peak_depth_m', 0)}m\n"

    arrival_distances = summary.get("arrival_distances", {})
    arrival_text = ""
    for dist, time_min in arrival_distances.items():
        if time_min is not None:
            arrival_text += f"  - {dist}: {time_min} minutes\n"
        else:
            arrival_text += f"  - {dist}: Not reached within simulation window\n"

    system_prompt = f"""{SYSTEM_PERSONA}

You are analyzing a dam break flood simulation for disaster preparedness.
Provide a comprehensive technical analysis covering:

1. EXECUTIVE SUMMARY - One paragraph overview for decision makers
2. BREACH ANALYSIS - Interpret breach parameters and their significance
3. FLOOD PROPAGATION - Explain how the flood wave travels downstream
4. VILLAGE IMPACT ASSESSMENT - Analyze each settlement's risk level
5. KEY OBSERVATIONS - Critical findings that require immediate attention

Use the provided simulation data. Be specific with numbers."""

    user_prompt = f"""SIMULATION DATA FOR ANALYSIS:

Dam: {dam_name}
Location: {dam_location.get('latitude', 'N/A')}°N, {dam_location.get('longitude', 'N/A')}°E
Dam Height: {dam_geom.get('dam_height_m', 'N/A')} m
Crest Elevation: {dam_geom.get('crest_elevation_m', 'N/A')} m

BREACH PARAMETERS:
- Peak Outflow: {breach.get('peak_outflow_cms', 'N/A')} m³/s
- Breach Width: {breach.get('breach_width_m', 'N/A')} m
- Formation Time: {breach.get('breach_formation_time_min', 'N/A')} min

TERRAIN:
- Min Elevation: {elev_stats.get('min_m', 'N/A')} m
- Max Elevation: {elev_stats.get('max_m', 'N/A')} m

FLOOD STATISTICS:
- Max Flood Depth: {summary.get('max_flood_depth_m', 'N/A')} m
- Max Inundated Area: {summary.get('max_inundated_area_km2', 'N/A')} km²
- Velocity Estimate: {summary.get('velocity_estimate_ms', 'N/A')} m/s

ARRIVAL TIMES:
{arrival_text}
DOWNSTREAM SETTLEMENTS:
{poi_text}
Please provide your technical analysis."""

    return system_prompt, user_prompt


# ---------------------------------------------------------------------------
# Recommendations Prompt
# ---------------------------------------------------------------------------

def build_recommendations_prompt(sim_data: dict) -> tuple:
    """Build prompt for generating emergency recommendations."""
    breach = sim_data.get("breach", {})
    summary = sim_data.get("summary", {})
    dam_name = sim_data.get("dam_name", "Unknown Dam")
    pois = summary.get("points_of_interest", [])

    pois_critical = [p for p in pois if p.get("peak_depth_m", 0) >= 1.0]
    pois_warning = [p for p in pois if 0.1 <= p.get("peak_depth_m", 0) < 1.0]
    pois_safe = [p for p in pois if p.get("peak_depth_m", 0) < 0.1]

    critical_names = ", ".join([p["name"] for p in pois_critical]) or "None"
    warning_names = ", ".join([p["name"] for p in pois_warning]) or "None"

    system_prompt = f"""{SYSTEM_PERSONA}

You are generating emergency preparedness recommendations based on a dam break simulation.
Provide actionable recommendations for:
1. EVACUATION PRIORITIES - Which areas need immediate evacuation
2. EARLY WARNING - What warning systems and timelines are needed
3. ROAD CLOSURES - Which transportation routes may be affected
4. TEMPORARY SHELTERS - Suggested shelter locations (upland areas)
5. RESERVOIR OPERATIONS - Advice for reservoir management
6. EMERGENCY RESPONSE - Priority actions for first responders

Be specific and actionable. Reference the simulation data."""

    user_prompt = f"""SIMULATION DATA FOR RECOMMENDATIONS:

Dam: {dam_name}
Peak Discharge: {breach.get('peak_outflow_cms', 'N/A')} m³/s
Breach Width: {breach.get('breach_width_m', 'N/A')} m
Max Flood Depth: {summary.get('max_flood_depth_m', 'N/A')} m
Flooded Area: {summary.get('max_inundated_area_km2', 'N/A')} km²

CRITICAL SETTLEMENTS (>1m depth): {critical_names}
WARNING SETTLEMENTS (0.1-1m depth): {warning_names}

ARRIVAL TIMES:
{chr(10).join([f"  - {dist}: {t} min" if t else f"  - {dist}: Not reached" for dist, t in summary.get('arrival_distances', {}).items()])}

Generate specific, actionable emergency recommendations."""

    return system_prompt, user_prompt


# ---------------------------------------------------------------------------
# Chat Prompt (with context)
# ---------------------------------------------------------------------------

def build_chat_system_prompt(sim_data: dict) -> str:
    """Build system prompt for interactive chat with simulation context."""
    dam_name = sim_data.get("dam_name", "Unknown Dam")
    summary = sim_data.get("summary", {})
    breach = sim_data.get("breach", {})
    pois = summary.get("points_of_interest", [])

    settlements = "\n".join([
        f"  - {p['name']}: depth={p.get('peak_depth_m', 0)}m, arrival={p.get('arrival_time_min', 'N/A')}min"
        for p in pois
    ])

    return f"""{SYSTEM_PERSONA}

You are an AI copilot assisting with dam break flood analysis.
Answer the user's questions about the simulation results below.
If the answer is not in the data, say so clearly.

SIMULATION CONTEXT:
Dam: {dam_name}
Peak Discharge: {breach.get('peak_outflow_cms', 'N/A')} m³/s
Max Flood Depth: {summary.get('max_flood_depth_m', 'N/A')} m
Flooded Area: {summary.get('max_inundated_area_km2', 'N/A')} km²
Velocity: {summary.get('velocity_estimate_ms', 'N/A')} m/s

ARRIVAL TIMES:
{chr(10).join([f"  - {d}: {t} min" if t else f"  - {d}: Not reached" for d, t in summary.get('arrival_distances', {}).items()])}

DOWNSTREAM SETTLEMENTS:
{settlements}

Answer concisely. Reference specific numbers from the data."""


# ---------------------------------------------------------------------------
# Report Prompt
# ---------------------------------------------------------------------------

def build_report_prompt(sim_data: dict) -> tuple:
    """Build prompt for generating a comprehensive report in Markdown."""
    breach = sim_data.get("breach", {})
    summary = sim_data.get("summary", {})
    dam_name = sim_data.get("dam_name", "Unknown Dam")
    dam_location = sim_data.get("dam_location", {})
    dam_geom = sim_data.get("dam_geometry", {})
    elev_stats = sim_data.get("elevation_stats", {})
    pois = summary.get("points_of_interest", [])

    pois_table = "\n".join([
        f"| {p['name']} | {p.get('arrival_time_min', 'N/A')} min | {p.get('peak_depth_m', 0)} m |"
        for p in pois
    ])

    system_prompt = f"""{SYSTEM_PERSONA}

Generate a professional dam break flood simulation report in Markdown format.
The report is intended for government officials and disaster management agencies.
Structure it with clear sections, use tables where appropriate, and include
a confidence statement at the end."""

    user_prompt = f"""Generate a comprehensive report for this simulation:

# Dam Break Simulation Report

## Dam Information
- Name: {dam_name}
- Location: {dam_location.get('latitude', 'N/A')}°N, {dam_location.get('longitude', 'N/A')}°E
- Dam Height: {dam_geom.get('dam_height_m', 'N/A')} m
- Crest Elevation: {dam_geom.get('crest_elevation_m', 'N/A')} m

## Simulation Results
- Peak Outflow: {breach.get('peak_outflow_cms', 'N/A')} m³/s
- Breach Width: {breach.get('breach_width_m', 'N/A')} m
- Formation Time: {breach.get('breach_formation_time_min', 'N/A')} min
- Max Flood Depth: {summary.get('max_flood_depth_m', 'N/A')} m
- Flooded Area: {summary.get('max_inundated_area_km2', 'N/A')} km²
- Velocity: {summary.get('velocity_estimate_ms', 'N/A')} m/s

## Settlement Impact
| Settlement | Arrival Time | Peak Depth |
|---|---|---|
{pois_table}

Generate the full report with these sections:
1. Executive Summary
2. Dam and Site Description
3. Breach Analysis
4. Flood Propagation Analysis
5. Settlement Impact Assessment
6. Emergency Response Recommendations
7. Limitations and Assumptions
8. Confidence Statement

Use professional language suitable for government officials."""

    return system_prompt, user_prompt


# ---------------------------------------------------------------------------
# Suggested Questions
# ---------------------------------------------------------------------------

SUGGESTED_QUESTIONS = [
    "Why is this area at risk?",
    "Which villages should evacuate first?",
    "How accurate is this prediction?",
    "Explain the flood timeline.",
    "What is the maximum water depth expected?",
    "How long does the breach take to form?",
    "Which settlement is affected first?",
    "What emergency actions should be taken immediately?",
]
