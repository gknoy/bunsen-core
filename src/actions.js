import _ from 'lodash'

import {getPath} from './dereference'
import {validateValue} from './validator'
import {aggregateResults} from './validator/utils'

export const CHANGE_VALUE = 'CHANGE_VALUE'
export const VALIDATION_RESOLVED = 'VALIDATION_RESOLVED'
export const CHANGE_MODEL = 'SET_MODEL'
export const CHANGE_VIEW = 'CHANGE_VIEW'

/**
 * Update form value
 * @param {String} bunsenId - path to form property to update (updates entire form if left empty)
 * @param {*} value - new form valud for bunsenId
 * @returns {Object} redux action
 */
export function changeValue (bunsenId, value) {
  return {
    type: CHANGE_VALUE,
    bunsenId,
    value
  }
}

/**
 * Update model
 * @param {BunsenModel} model - new bunsen model
 * @returns {Object} redux action
 */
export function changeModel (model) {
  return {
    type: CHANGE_MODEL,
    model
  }
}

/**
 * Update view
 * @param {BunsenView} view - new bunsen view
 * @returns {Object} redux action
 */
export function changeView (view) {
  return {
    type: CHANGE_VIEW,
    view
  }
}

export function updateValidationResults (validationResult) {
  const errorsByInput = _.groupBy(validationResult.errors, 'path')
  const errorsFilteredToMessagesOnly = _.mapValues(
    errorsByInput,
    (fieldErrors, bunsenId) => _.map(fieldErrors, 'message')
  )
  const errorsMappedToDotNotation = _.mapKeys(errorsFilteredToMessagesOnly, (value, key) => getPath(key))

  return {
    errors: errorsMappedToDotNotation,
    type: VALIDATION_RESOLVED,
    validationResult
  }
}

function invalidPath (refPath) {
  console.warn(`${refPath} is not a valid path`)
  return {}
}

function schemaFromRef (definitions) {
  if (definitions === undefined) {
    return function (refPath) {
      const schema = invalidPath(refPath)
      console.warn('"$ref" can not be used, "definitions" is not defined for this schema')
      return schema
    }
  }

  return function (refPath, resolveRef) {
    const pathStack = refPath.split('/').reverse()
    if (pathStack.pop() !== '#' || pathStack.pop() !== 'definitions') {
      return invalidPath(refPath)
    }
    const startingSchema = definitions[pathStack.pop()]
    if (pathStack.length <= 0) {
      return startingSchema
    }
    return getSchema(pathStack, startingSchema, resolveRef)
  }
}

function getSchema (pathStack, model, resolveRef) {
  if (model.$ref !== undefined) {
    return resolveRef(model.$ref, resolveRef)
  }

  if (pathStack.length <= 0) {
    return model
  }

  if (model.properties) {
    const current = pathStack.pop()
    return getSchema(pathStack, model.properties[current], resolveRef)
  }

  if (model.items) { // This model is an array
    pathStack.pop() // Remove index since it doesn't provide any more useful information
    return getSchema(pathStack, model.items, resolveRef)
  }

  return {}
}

function findSchema (model, path, resolveRef) {
  if (model.$ref !== undefined) {
    return getSchema(null, model, resolveRef)
  } else if (path === null) {
    return model
  }

  const pathStack = path && path.split('.').reverse() || []
  return getSchema(pathStack, model, resolveRef)
}

/**
 * Returns the value with defaults provided by the schema
 * @param {Object} value - a complex object/array (the bunsen form value)
 * @param {String} path - path to retrieve the sub schema of the model given
 * @param {Object} model - bunsen model schema
 * @param {Function} resolveRef - function to resolve references
 * @returns {Object} the value with defaults applied
 */
function getDefaults (value, path, model, resolveRef) {
  const schema = findSchema(model, path, resolveRef)
  const schemaDefault = _.clone(schema.default)

  if (model.type === 'object') {
    const subSchemaDefaults = {}
    _.forIn(schema.properties, function (subSchema, propName) {
      const defaults = getDefaults(
        value && value[propName],
        null,
        subSchema,
        resolveRef
      )
      if (defaults !== undefined) {
        subSchemaDefaults[propName] = defaults
      }
    })

    if (Object.keys(subSchemaDefaults).length > 0) {
      return _.defaults({}, schemaDefault, subSchemaDefaults)
    }
    return schemaDefault
  } else if (value !== undefined) {
    return value
  }
  return schemaDefault
}

function isEmptyValue (value) {
  return [undefined, null].indexOf(value) !== -1 ||
  (_.isObject(value) && Object.keys(value).length === 0) // Check if empty object
}

function dispatchUpdatedResults (dispatch, results) {
  const aggregatedResult = aggregateResults(results)
  // TODO: Dispatch an err action
  dispatch(updateValidationResults(aggregatedResult))
}

function getDefaultedValue ({inputValue, previousValue, bunsenId, renderModel, mergeDefaults}) {
  const isInputValueEmpty = isEmptyValue(inputValue)

  if (previousValue !== undefined) {
    return inputValue
  }

  const resolveRef = schemaFromRef(renderModel.definitions)
  const defaultValue = getDefaults(inputValue, bunsenId, renderModel, resolveRef)
  const hasDefaults = defaultValue !== undefined
  const isUpdatingAll = bunsenId === null

  const shouldApplyDefaults = isInputValueEmpty && hasDefaults ||
    !isInputValueEmpty && hasDefaults && isUpdatingAll && mergeDefaults
  const shouldClear = isInputValueEmpty && isUpdatingAll && !hasDefaults

  if (shouldApplyDefaults) {
    return _.defaults({}, inputValue, defaultValue)
  } else if (shouldClear) {
    return {}
  }

  return inputValue
}

/**
 * Validate action
 * @param {String} bunsenId - bunsen ID of what changed
 * @param {Object} inputValue - value of what changed
 * @param {Object} renderModel - bunsen model
 * @param {Array<Function>} validators - custom validators
 * @param {Function} [all=Promise.all] - framework specific Promise.all method
 * @param {Boolean} [forceValidation=false] - whether or not to force validation
 * @param {Boolean} [mergeDefaults=false] - whether to merge defaults with initial values
 * @returns {Function} Function to asynchronously validate
 */
export function validate (
  bunsenId, inputValue, renderModel, validators, all = Promise.all, forceValidation = false, mergeDefaults = false
) {
  return function (dispatch, getState) {
    let formValue = getState().value
    const previousValue = _.get(formValue, bunsenId)

    inputValue = getDefaultedValue({inputValue, previousValue, bunsenId, renderModel, mergeDefaults})

    // if the value never changed, no need to update and validate (unless consumer
    // is forcing validation again)
    if (!forceValidation && _.isEqual(inputValue, previousValue)) {
      return
    }

    dispatch(changeValue(bunsenId, inputValue))

    // We must lookup the formValue again in order for the validation results to
    // be run on the post-change value rather than the pre-change value
    formValue = getState().value

    const result = validateValue(formValue, renderModel)

    const promises = []
    validators.forEach((validator) => {
      promises.push(validator(formValue))
    })

    // Promise.all fails in Node when promises array is empty
    if (promises.length === 0) {
      dispatchUpdatedResults(dispatch, [result])
      return
    }

    all(promises)
      .then((snapshots) => {
        const results = _.map(snapshots, 'value')
        results.push(result)
        dispatchUpdatedResults(dispatch, results)
      })
  }
}
