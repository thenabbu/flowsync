# FlowSync Network

### Adaptive Traffic Signal Simulation

FlowSync Network is a browser-based traffic management simulation that models **four connected intersections in a 2×2 road network**.

It demonstrates how adaptive traffic signals can respond to changing vehicle queues, emergency vehicles, and pedestrian crossing requests.

> **Note:** FlowSync is a simulation prototype for demonstration and learning. It does not control real traffic signals and does not use live traffic-camera or GPS data.

---

## Features

- **2×2 connected intersection network**
  - Four coordinated intersections
  - Vehicles move between intersections instead of disappearing at every junction

- **Adaptive traffic signal control**
  - Signal timing responds to traffic queue pressure
  - Supports Adaptive and Fixed-time modes

- **Traffic scenarios**
  - Normal traffic
  - Rush-hour traffic
  - East-heavy traffic

- **Emergency vehicle priority**
  - Dispatch an emergency vehicle
  - Temporarily prioritizes its route through intersections

- **High-visibility pedestrian crossing / WALK phase requests**
  - Simulates pedestrian crossing interruptions
  - Gives pedestrians a dedicated crossing phase

- **Explainable decisions**
  - Displays why the controller changes signal phases
  - Shows queue counts and decision thresholds

- **Performance comparison**
  - Compares Fixed-time and Adaptive control
  - Uses the same traffic seed for a more consistent comparison

- **Network metrics**
  - Average trip waiting time
  - Maximum queue length
  - Throughput
  - Total delay
  - Active vehicles

- **Interactive visualization**
  - Animated traffic network
  - Queue history chart
  - Controller log
  - Intersection status cards

---

## Tech Stack

- HTML5
- CSS3
- JavaScript
- HTML Canvas API

No frameworks, build tools, or external dependencies are required.

---

## Run Locally

### Option 1: Open directly

1. Download or clone this repository.
2. Open `index.html` in your browser.

### Option 2: Run with a local server

If Python is installed, open the project folder in a terminal and run:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

---

## Project Structure

```text
flowsync-network/
├── index.html      # Main application interface
├── styles.css      # Application styling and responsive layout
├── script.js       # Traffic simulation and signal-control logic
├── README.md       # Project documentation
└── .gitignore      # Git ignore rules
```

---

## How It Works

1. Vehicles are generated according to the selected traffic scenario.
2. Each intersection maintains queues for north, south, east, and west approaches.
3. The controller evaluates traffic pressure and chooses the active signal phase.
4. Vehicles move through the network and are handed off to connected intersections.
5. Emergency and pedestrian requests temporarily override normal signal behavior.
6. The application records network metrics and displays controller decisions.

---

## GitHub Pages

This project is a static website and can be deployed using **GitHub Pages**.

After uploading the files to a GitHub repository:

1. Open the repository on GitHub.
2. Go to **Settings → Pages**.
3. Select the deployment branch, usually `main`.
4. Select the root folder `/`.
5. Save the settings.

GitHub will provide a public URL for the project.

---

## Limitations

- Traffic behavior is simulated, not measured from real-world data.
- Performance results depend on the selected traffic scenario and simulation seed.
- The adaptive controller is a demonstration algorithm, not a production traffic-control system.
- The project does not connect to real traffic lights, cameras, sensors, or GPS services.

---

## Future Improvements

- Real-time traffic-camera integration
- Machine-learning-based traffic prediction
- More intersections and road layouts
- Route optimization for emergency vehicles
- Weather and accident scenarios
- Exportable performance reports
- Backend support for storing simulation results

---

## Contributors

- [Drishya Singhal](https://github.com/Drishya-code)
- [Navya Gupta](https://github.com/thenabbu)
- [Sanchit Grover](https://github.com/Astro-coder07)
- [Ayush Srivastav](https://github.com/Ayush24107)

---
## License

This project is available for educational, demonstration, and experimentation purposes.
