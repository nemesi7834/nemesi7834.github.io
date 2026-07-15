const dashboard = document.querySelector("#dashboard");
const engagementFooter = document.querySelector("#engagement-footer");
const template = document.querySelector("#metric-card-template");

fetch("./data/metrics.json")
  .then((response) => {
    if (!response.ok) throw new Error("Could not load metrics snapshot.");
    return response.json();
  })
  .then(renderDashboard)
  .catch(() => {
    dashboard.innerHTML = '<p class="section__description">The dashboard snapshot is temporarily unavailable.</p>';
  });

function renderDashboard(data) {
  document.querySelector("#snapshot-date").textContent = `Source snapshot: ${data.snapshotDate}`;
  data.sections.forEach((section) => {
    const destination = section.placement === "footer" ? engagementFooter : dashboard;
    const sectionElement = document.createElement("section");
    sectionElement.className = "section";
    sectionElement.innerHTML = `<h2 class="section__title">${section.title}</h2><p class="section__description">${section.description}</p>`;
    const grid = document.createElement("div");
    grid.className = "card-grid";
    section.metrics.forEach((metric) => grid.append(createMetricCard(metric)));
    sectionElement.append(grid);
    destination.append(sectionElement);
  });
}

function createMetricCard(metric) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".metric-card");
  const latest = metric.history.at(-1);
  const badge = fragment.querySelector(".trend-badge");
  const value = fragment.querySelector(".metric-value");

  fragment.querySelector("h3").textContent = metric.name;
  badge.textContent = metric.trend.label;
  badge.dataset.trend = metric.trend.kind;
  value.textContent = latest.value;
  value.classList.toggle("is-pending", latest.status === "pending");
  fragment.querySelector(".metric-period").textContent = latest.label;
  fragment.querySelector(".metric-target").textContent = metric.target ? `Target: ${metric.target}` : "";

  const chartHost = fragment.querySelector(".sparkline");
  const numericPoints = metric.history.filter((point) => Number.isFinite(point.numeric));
  if (numericPoints.length > 1) chartHost.append(drawSparkline(numericPoints, metric.trend.kind));

  const history = fragment.querySelector(".history ul");
  metric.history.slice().reverse().forEach((point) => {
    const item = document.createElement("li");
    item.textContent = `${point.label}: ${point.value}`;
    history.append(item);
  });
  return card;
}

function drawSparkline(points, trend) {
  const width = 220;
  const height = 42;
  const values = points.map((point) => point.numeric);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const color = trend === "watch" ? "#bb3d3d" : trend === "down" ? "#b76b00" : "#0a8378";
  const coordinates = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 4 - ((value - min) / range) * (height - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `<path d="M0 ${height - 3} H${width}" stroke="#e5eaed" stroke-width="1"/><polyline points="${coordinates.join(" ")}" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"/>`;
  return svg;
}
