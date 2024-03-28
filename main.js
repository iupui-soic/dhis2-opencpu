let jsonData;

document.addEventListener('DOMContentLoaded', function() {
  // Fetch DHIS2 datasets and populate the drop-down menu
  fetchDHIS2Data('dataset-select', 'dataSets.json');
  fetchDHIS2Data('legend-select', 'legendSets.json');
  fetchDHIS2Data('data-element-select', 'dataElements.json');
  fetchDHIS2Data('indicator-select', 'indicators.json');
  fetchDHIS2Data('org-unit-select', 'organisationUnits.json');
  fetchJsonData();
});

function fetchJsonData() {
  // Construct the DHIS2 API endpoint to fetch the JSON data
  const apiUrl = 'dataValueSets.json'; // This endpoint fetches the data values directly

  // Fetch JSON data from the DHIS2 API
  const dhis2ApiUrl = `https://play.dhis2.org/40.3.0/api/29/${apiUrl}`;

  fetch(dhis2ApiUrl)
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      // Assign the fetched JSON data to the global variable
      jsonData = data;
    })
    .catch(error => {
      console.error('Error fetching JSON data:', error);
    });
}

function fetchDHIS2Data(selectId, apiUrl) {
  // Use DHIS2 API to fetch data
  const dhis2ApiUrl = `https://play.dhis2.org/40.3.0/api/29/${apiUrl}`;

  fetch(dhis2ApiUrl)
    .then(response => response.json())
    .then(data => {
      const select = document.getElementById(selectId);
      // Clear existing options
      select.innerHTML = '';

      // Populate the drop-down menu with data options
      data[apiUrl.split('.')[0]].forEach(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.text = item.displayName;
        select.add(option);
      });
    })
    .catch(error => console.error(`Error fetching ${apiUrl}: `, error));
}

function fetchData() {
  // Fetch data based on selected options
  const selectedDatasetIds = getSelectedValues('dataset-select');
  const selectedLegendIds = getSelectedValues('legend-select');
  const selectedDataElementIds = getSelectedValues('data-element-select');
  const selectedIndicatorIds = getSelectedValues('indicator-select');
  const selectedOrgUnitIds = getSelectedValues('org-unit-select');
  const fromDate = document.getElementById('from-date').value;
  const toDate = document.getElementById('to-date').value;

  // Construct the API endpoint with the selected parameters
  const apiEndpoint = `https://play.dhis2.org/40.3.0/api/29/dataValueSets.json?dataSet=${selectedDatasetIds.join(',')}&legendSet=${selectedLegendIds.join(',')}&dataElement=${selectedDataElementIds.join(',')}&indicator=${selectedIndicatorIds.join(',')}&orgUnit=${selectedOrgUnitIds.join(',')}&startDate=${fromDate}&endDate=${toDate}`;

  // Fetch data from DHIS2
  fetch(apiEndpoint)
    .then(response => {
      if (!response.ok) {
        return response.text().then(text => { throw new Error(`${response.status} - ${text}`) });
      }
      return response.json();
    })
    .then(data => {
      // Display the fetched data
      const responseOutput = document.getElementById('response-output');
      responseOutput.textContent = JSON.stringify(data, null, 2);
    })
    .catch(error => {
      console.error('Error fetching data from DHIS2: ', error);
      const responseOutput = document.getElementById('response-output');
      responseOutput.textContent = `Failed to load response: ${error.message}`;
    });
}

function getSelectedValues(selectId) {
  const select = document.getElementById(selectId);
  const selectedOptions = Array.from(select.selectedOptions);
  return selectedOptions.map(option => option.value);
}

document.getElementById('runCode').addEventListener('click', function() {
  var code = document.getElementById('codeInput').value.trim();
  var resultContainer = document.getElementById('response-output');

  resultContainer.textContent = "Running...";

  // Adjust the OpenCPU API endpoint for running R code
  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://cloud.opencpu.org/ocpu/library/stats/R', true); // Adjust the endpoint
  xhr.setRequestHeader('Content-Type', 'application/json');

  // Pass the R code as a parameter
  var params = {
      code: code
  };

  xhr.onreadystatechange = function() {
      if(xhr.readyState === XMLHttpRequest.DONE) {
          var status = xhr.status;
          if (status === 0 || (status >= 200 && status < 400)) {
              // The request has been completed successfully
              resultContainer.textContent = xhr.responseText;
          } else {
              // Oh no! There has been an error with the request!
              resultContainer.textContent = "Error: " + xhr.statusText;
          }
      }
  };
  xhr.send(JSON.stringify(params));
});