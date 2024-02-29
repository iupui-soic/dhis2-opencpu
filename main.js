document.addEventListener('DOMContentLoaded', function() {
  // Fetch DHIS2 datasets and populate the drop-down menu
  fetchDHIS2Data('dataset-select', 'dataSets.json');
  fetchDHIS2Data('legend-select', 'legendSets.json');
  fetchDHIS2Data('data-element-select', 'dataElements.json');
  fetchDHIS2Data('indicator-select', 'indicators.json');
  fetchDHIS2Data('org-unit-select', 'organisationUnits.json');
});

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
